// Runs a snippet in a QuickJS WebAssembly sandbox inside the runner's process. The snippet gets only what
// PRELUDE defines (`webflow`, `cms`, `console`, `args`, `out` and `sleep`) and has no network, file system, process
// or environment access of its own. Every Webflow call, file operation and upload goes through the host functions here.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";
import wasmFile from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, newVariant, type QuickJSHandle } from "quickjs-emscripten";
import { errorMessage } from "../errors.ts";

export interface SandboxHost {
  args: string[];
  // The only folder `out.read()` and `out.write()` can reach.
  outDir: string;
  call(tool: string, action: string | null, input: unknown, toolArgs: unknown): Promise<unknown>;
  // Send a file in outDir (full path) to an upload target from create_asset and the like (upload.ts).
  upload?(file: string, target: unknown): Promise<unknown>;
  print(text: string): void;
  // Checked while snippet code runs, where timers can't fire: returning true stops the run, as an abort does.
  shouldStop?(): boolean;
}

// "stopped" means the run was aborted, e.g. by the runner's timeout.
export type SandboxResult = "ok" | "error" | "stopped";

const MEMORY_LIMIT = 512 * 1024 * 1024;
const STACK_LIMIT = 1024 * 1024;
// After a stop, calls already sent to Webflow get this long to finish before the run ends anyway.
const STOP_GRACE_MS = 15_000;
const CODE_FILE = /\.(ts|mts|js|mjs)$/;

// Bundle a snippet and the files it imports into one ES module. Imports must be relative paths to code files
// inside the snippet's own folder, so a snippet can't pull in packages, Node built-ins or data files.
export async function bundleSnippet(entry: string): Promise<string> {
  // Real paths, so a symlink can't point an import outside the folder.
  const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
  const root = real(path.dirname(entry));
  const guard: BunPlugin = {
    name: "snippet-imports",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer) return;
        const full = real(path.resolve(path.dirname(args.importer), args.path));
        if (args.path.startsWith(".") && CODE_FILE.test(full) && !path.relative(root, full).startsWith("..")) {
          return { path: full };
        }
        throw new Error(
          `${path.relative(root, args.importer)} imports "${args.path}". Snippets can only import .ts or .js files from their own folder, with the extension written out.`,
        );
      });
    },
  };
  const result = await Bun.build({ entrypoints: [real(entry)], target: "browser", format: "esm", plugins: [guard], throw: false });
  if (!result.success) throw new Error(result.logs.map((l) => l.message).join("\n"));
  const [bundle] = result.outputs;
  if (!bundle) throw new Error("Bundling produced no output.");
  return bundle.text();
}

// Guest-side setup. Takes the host functions off the global object and defines the snippet's globals.
const PRELUDE = (args: string[]) => `(() => {
  const host = { call: __wf_call, print: __wf_print, write: __wf_write, read: __wf_read, md5: __wf_md5, upload: __wf_upload, sleep: __wf_sleep };
  for (const name of Object.keys(globalThis)) if (name.startsWith("__wf_")) delete globalThis[name];
  const show = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message + (v.stack ? "\\n" + v.stack.trimEnd() : "");
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
  };
  const print = (...values) => host.print(values.map(show).join(" "));
  const call = (tool, action, input, toolArgs) =>
    host.call(tool, action ?? "", JSON.stringify(input ?? {}), JSON.stringify(toolArgs ?? {})).then(JSON.parse);
  // webflow.<tool>(input) calls a tool directly; webflow.<tool>.<action>(input, toolArgs) calls one action.
  // \`then\` is left undefined so awaiting a proxy by mistake doesn't hang.
  const webflow = new Proxy({}, {
    get: (_, tool) => typeof tool !== "string" || tool === "then" ? undefined : new Proxy(function () {}, {
      apply: (_t, _this, a) => call(tool, null, a[0], undefined),
      get: (_t, action) => typeof action !== "string" || action === "then" ? undefined : (input, toolArgs) => call(tool, action, input, toolArgs),
    }),
  });
  // CMS helpers; their contract is in globals.d.ts. listAll reads every page of list_collection_items (100 items
  // each, the most it returns) and throws unless every page reports the same pagination.total and it got exactly
  // that many distinct items. That catches most edits made while it reads, though Webflow offers no snapshot.
  const PAGE = 100;
  const listPage = async (collectionId, request, offset) => {
    const page = await call("data_cms_tool", "list_collection_items", { collection_id: collectionId, request: { ...request, limit: PAGE, offset } }, undefined);
    if (!page || !Array.isArray(page.items) || typeof page.pagination?.total !== "number" || page.items.some((i) => typeof i?.id !== "string")) {
      throw new Error("cms.listAll: list_collection_items (" + collectionId + ", offset " + offset + ") didn't return items with IDs and a pagination.total.");
    }
    return page;
  };
  const isDate = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
  const isItem = (i) =>
    typeof i?.isDraft === "boolean" && typeof i.isArchived === "boolean" && isDate(i.lastUpdated) &&
    (i.lastPublished === null || isDate(i.lastPublished));
  const checkItem = (i, fn) => {
    if (!isItem(i)) throw new Error("cms." + fn + " takes a CMS item as list_collection_items returns it, with isDraft, isArchived, lastUpdated and lastPublished.");
  };
  const cms = {
    listAll: async (input) => {
      const collectionId = input?.collection_id;
      const request = input?.request;
      if (typeof collectionId !== "string") throw new Error("cms.listAll takes { collection_id, request? }, like list_collection_items.");
      if (request && ("limit" in request || "offset" in request)) throw new Error("cms.listAll reads every page itself; leave out limit and offset.");
      const first = await listPage(collectionId, request ?? {}, 0);
      const offsets = [];
      for (let o = PAGE; o < first.pagination.total; o += PAGE) offsets.push(o);
      const pages = [first, ...(await Promise.all(offsets.map((o) => listPage(collectionId, request ?? {}, o))))];
      const total = first.pagination.total;
      const moved = pages.find((p) => p.pagination.total !== total);
      if (moved) {
        throw new Error("cms.listAll: " + collectionId + " had " + total + " items, then " + moved.pagination.total + " while it read. Run it again.");
      }
      const items = pages.flatMap((p) => p.items);
      // With several locales, each locale's variant of an item is its own entry, so an item ID can repeat.
      const distinct = new Set(items.map((i) => i.id + " " + (i.cmsLocaleId ?? ""))).size;
      if (items.length !== total || distinct !== items.length) {
        throw new Error("cms.listAll: got " + items.length + " entries (" + distinct + " distinct) of " + total + " from " + collectionId + "; items were probably added or removed while it read. Run it again.");
      }
      return items;
    },
    itemState: (item) => {
      checkItem(item, "itemState");
      if (item.isArchived) return "archived";
      if (item.lastPublished === null) return item.isDraft ? "draft" : "staged";
      if (item.isDraft) return "changes-in-draft";
      return Date.parse(item.lastUpdated) > Date.parse(item.lastPublished) ? "changes-staged" : "published";
    },
    isLive: (item) => {
      checkItem(item, "isLive");
      return !item.isArchived && item.lastPublished !== null;
    },
  };
  const out = {
    write: (name, data) => host.write(String(name), typeof data === "string" ? data : JSON.stringify(data, null, 2)),
    read: (name) => host.read(String(name)),
    md5: (name) => host.md5(String(name)),
    upload: (name, target) => host.upload(String(name), JSON.stringify(target ?? null)).then(JSON.parse),
  };
  const define = (name, value) => Object.defineProperty(globalThis, name, { value: Object.freeze(value) });
  define("webflow", webflow);
  define("cms", cms);
  define("console", { log: print, info: print, warn: print, error: print, debug: print });
  define("args", JSON.parse(${JSON.stringify(JSON.stringify(args))}));
  define("out", out);
  define("sleep", (ms) => host.sleep(String(Number(ms) || 0)));
})();`;

// The wasm is embedded in the compiled binary, where the module can't find it next to its own file, so it's
// handed over as bytes.
const getQuickJS = async () =>
  newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmBinary: await Bun.file(wasmFile).arrayBuffer() }));

export async function runSandboxed(code: string, host: SandboxHost, abort: AbortSignal): Promise<SandboxResult> {
  const stop = new AbortController();
  abort.addEventListener("abort", () => stop.abort());
  const signal = stop.signal;
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT);
  runtime.setMaxStackSize(STACK_LIMIT);
  // Stops snippet code that never yields, such as an endless loop, which holds the thread so no timer can fire.
  runtime.setInterruptHandler(() => {
    if (host.shouldStop?.()) stop.abort();
    return signal.aborted;
  });
  // The VM is never disposed: the runner exits right after, and calls still in flight may settle into it.
  const vm = runtime.newContext();

  const outPath = (name: string) => {
    const full = path.resolve(host.outDir, name);
    const rel = path.relative(host.outDir, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`out paths must stay inside out/: "${name}"`);
    return full;
  };

  // Webflow calls the host is still working on. A run ends only once these settle.
  let inflight = 0;
  let onIdle: (() => void) | undefined;
  const pump = () => {
    if (!signal.aborted) runtime.executePendingJobs();
  };
  // `tracked` calls count toward `inflight`; a pending sleep shouldn't hold the run open.
  const asyncFn = (name: string, fn: (...params: string[]) => Promise<string>, tracked = true) => {
    const handle = vm.newFunction(name, (...handles) => {
      const params = handles.map((h) => vm.getString(h));
      const deferred = vm.newPromise();
      if (signal.aborted) {
        deferred.reject(vm.newError("The run was stopped."));
        return deferred.handle;
      }
      if (tracked) inflight++;
      const settle = (h: QuickJSHandle, ok: boolean) => {
        (ok ? deferred.resolve : deferred.reject)(h);
        h.dispose();
      };
      fn(...params)
        .then(
          (value) => settle(vm.newString(value), true),
          (err) => settle(vm.newError(errorMessage(err)), false),
        )
        .finally(() => {
          if (tracked && --inflight === 0) onIdle?.();
          pump();
        });
      return deferred.handle;
    });
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  const syncFn = (name: string, fn: (...params: string[]) => string | void) => {
    const handle = vm.newFunction(name, (...handles) => {
      const value = fn(...handles.map((h) => vm.getString(h)));
      return value === undefined ? undefined : vm.newString(value);
    });
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };

  asyncFn("__wf_call", async (tool, action, input, toolArgs) =>
    JSON.stringify((await host.call(tool, action || null, JSON.parse(input), JSON.parse(toolArgs))) ?? null),
  );
  asyncFn("__wf_sleep", (ms) => new Promise((resolve) => setTimeout(() => resolve("null"), Number(ms))), false);
  syncFn("__wf_print", (text) => host.print(text));
  syncFn("__wf_write", (name, text) => {
    const file = outPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  });
  syncFn("__wf_read", (name) => fs.readFileSync(outPath(name), "utf8"));
  syncFn("__wf_md5", (name) => createHash("md5").update(fs.readFileSync(outPath(name))).digest("hex"));
  asyncFn("__wf_upload", async (name, target) => {
    if (!host.upload) throw new Error("Uploads aren't available here.");
    return JSON.stringify((await host.upload(outPath(name), JSON.parse(target))) ?? null);
  });
  vm.unwrapResult(vm.evalCode(PRELUDE(host.args), "prelude.js")).dispose();

  const report = (error: QuickJSHandle) => {
    const e = vm.dump(error) as { name?: string; message?: string; stack?: string } | string;
    error.dispose();
    if (typeof e !== "object" || !e) return host.print(String(e));
    host.print(`${e.name ?? "Error"}: ${e.message ?? JSON.stringify(e)}${e.stack ? `\n${e.stack.trimEnd()}` : ""}`);
  };

  // A module with top-level await evaluates to a promise of its exports.
  let result: SandboxResult;
  const evaluated = vm.evalCode(code, "snippet.js", { type: "module" });
  if (evaluated.error && signal.aborted) {
    evaluated.error.dispose();
    result = "stopped";
  } else if (evaluated.error) {
    report(evaluated.error);
    result = "error";
  } else {
    const settled = vm.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    pump();
    const stopped = new Promise<"stopped">((resolve) => signal.addEventListener("abort", () => resolve("stopped")));
    const outcome = await Promise.race([settled, stopped]);
    if (outcome === "stopped" || signal.aborted) result = "stopped";
    else if (outcome.error) {
      report(outcome.error);
      result = "error";
    } else {
      outcome.value.dispose();
      result = "ok";
    }
  }

  // Let calls already sent finish, so a write isn't cut off halfway. A settled call can let the snippet start
  // another, so wait until none are left. After a stop no new calls start, and the wait is capped.
  const graceEnd = Date.now() + STOP_GRACE_MS;
  while (inflight) {
    const idle = new Promise<void>((resolve) => (onIdle = resolve));
    if (result !== "stopped") await idle;
    else {
      const left = graceEnd - Date.now();
      if (left <= 0) break;
      await Promise.race([idle, new Promise((r) => setTimeout(r, left))]);
    }
  }
  if (inflight) host.print(`[wf-mcp] ${inflight} call(s) to Webflow were still running when the run ended; check the site.`);
  return result;
}
