// Run a snippet against Webflow's MCP server, with read-only access unless widened.
//   wf-mcp run <snippet.ts> [args...] [--allow sensitive,write,destructive] [--max-output 20000] [--timeout 90]
//              [--context "..."] [--login] [--no-check] [--concurrency 4]
// Extra arguments reach the snippet as the global `args`.
//
// The snippet and the files it imports from its folder are bundled, then run in a QuickJS sandbox (sandbox/sandbox.ts)
// with no network, file system, process or environment access. Its globals are `webflow`, `console`, `args`, `out`
// (read and write files in out/, and upload them for create_asset and the like; upload.ts) and `sleep`. This process checks each `webflow` call against the access levels
// in the access table (access.ts), asks the user to approve anything above a read (confirm.ts) unless they chose to always
// allow it (trust.ts), then forwards it with the stored credentials. out/ and types/ live in the runner's home folder (paths.ts).
// Only the snippet's console output comes back, capped at --max-output characters; the full log goes to out/.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ACCESS_LEVELS, parseAllow, type Access } from "./access.ts";
import { LoginRequiredError, callOutput, connect, type WebflowMcp } from "./client.ts";
import { confirmCall } from "./confirm.ts";
import { errorMessage } from "./errors.ts";
import { buildManifest, diffManifests, readManifest, staleTypes, writeTypes, type Manifest } from "./gen-types.ts";
import { RateGate, limiter, longOutputNote, truncateMiddle } from "./limits.ts";
import { OUT_DIR, SUPPORT_DIR, TYPES_DIR, tscPath } from "./paths.ts";
import { merge, saveShapes, shapeOf, type Shape } from "./shapes.ts";
import { APPROVAL_DAYS, isRemembered, remember, rememberable } from "./trust.ts";
import { bundleSnippet, runSandboxed } from "./sandbox/sandbox.ts";
import { UploadTargets } from "./upload.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    allow: { type: "string", default: "read" },
    "max-output": { type: "string", default: "20000" },
    // Under Claude Code's default 2-minute command limit, with room to connect and list tools first.
    timeout: { type: "string", default: "90" },
    context: { type: "string" },
    // Allow a browser login even without a terminal. Without one, a needed login fails fast instead.
    login: { type: "boolean", default: false },
    // Skip typechecking the snippet before it runs.
    "no-check": { type: "boolean", default: false },
    // Webflow calls in flight at once. More than this wait their turn instead of tripping the rate limit.
    concurrency: { type: "string", default: "4" },
  },
});
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [snippetArg] = positionals;
if (!snippetArg) fail("Usage: wf-mcp run <snippet.ts> [args...] [--allow sensitive,write,destructive]");
if (!fs.existsSync(snippetArg)) fail(`No such snippet: ${snippetArg}`);
const snippet = fs.realpathSync(snippetArg);
let allowed = new Set<Access>();
try {
  allowed = parseAllow(opts.allow!);
} catch (err) {
  fail(errorMessage(err));
}
const maxOutput = Number(opts["max-output"]);
const concurrency = Math.max(1, Number(opts.concurrency) || 1);
// Up to --concurrency calls at once, fewer while Webflow is rate limiting the run (RateGate).
const limit = limiter(() => mcp.rateGate.concurrency());

// Bundle first, so a bad import fails before anything connects.
let code = "";
try {
  code = await bundleSnippet(snippet);
} catch (err) {
  fail(`Could not bundle ${snippetArg}:\n${errorMessage(err)}`);
}

// The snippet's timeout. It stops while the user logs in again after a 401, then restarts in full. The timer
// stops a snippet waiting on calls; the deadline is checked while snippet code runs, when no timer can fire.
const timeoutMs = Number(opts.timeout) * 1000;
const stopRun = new AbortController();
let started = false;
let timedOut = false;
// When the timeout fired, so the summary counts only the rate-limit pauses before it.
let stoppedAt: number | undefined;
let deadline = Infinity;
let timer: ReturnType<typeof setTimeout> | undefined;
const expire = () => {
  timedOut = true;
  stoppedAt ??= Date.now();
  stopRun.abort();
};
const startTimer = () => {
  deadline = Date.now() + timeoutMs;
  timer = setTimeout(expire, timeoutMs);
};
const pauseTimer = () => {
  clearTimeout(timer);
  deadline = Infinity;
};
// Logins and confirmation prompts pause the timeout; it restarts in full when the last of them ends.
let pauses = 0;
const hold = () => {
  if (pauses++ === 0 && started) pauseTimer();
};
const release = () => {
  if (--pauses === 0 && started) startTimer();
};

let mcp: WebflowMcp;
try {
  mcp = await connect({
    name: "wf-mcp-run",
    context:
      opts.context ??
      `Running the snippet ${path.basename(snippet)} through the wf-mcp runner to read or change Webflow site data for its user.`,
    login: opts.login || undefined,
    onLogin: (phase) => (phase === "start" ? hold() : release()),
  });
} catch (err) {
  if (!(err instanceof LoginRequiredError)) throw err;
  console.error(err.message);
  process.exit(3);
}
mcp.rateGate = new RateGate({ concurrency });

// Regenerate types/ when Webflow's tool schemas no longer match the ones they were generated from. A run that
// may change the site stops there, so the changes and any guessed access levels get a look first. Types written
// by an older binary in an older format are rewritten quietly: nothing about the tools changed.
let manifest: Manifest | undefined = readManifest();
const { tools } = await mcp.client.listTools();
const stale = staleTypes(manifest, tools);
if (stale === "format") manifest = writeTypes(tools);
if (stale === "schemas") {
  const before = manifest;
  manifest = writeTypes(tools);
  console.error("[wf-mcp] Webflow's tool schemas changed, so types/ was regenerated:");
  for (const line of diffManifests(before, manifest)) console.error(`[wf-mcp]   ${line}`);
  if (allowed.has("write")) {
    await mcp.client.close();
    console.error("[wf-mcp] Not running a snippet that may write after a schema change. Check the changes above, then run it again.");
    process.exit(4);
  }
}

// Access levels for this run, from the live tool list and the access table compiled into this binary. The
// manifest in types/ only decides whether the types need regenerating.
const levels = buildManifest(tools);

// Typecheck the snippet on its own against the current types and the sandbox's globals, before any call is made.
// The compiler ships next to the binary; without it the run goes ahead unchecked.
const tsc = tscPath();
if (!opts["no-check"] && !tsc) console.error("[wf-mcp] No TypeScript compiler next to the binary, so the snippet runs without a typecheck.");
if (!opts["no-check"] && tsc) {
  const config = path.join(OUT_DIR, `.tsconfig-${process.pid}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    config,
    JSON.stringify({
      extends: path.join(SUPPORT_DIR, "tsconfig.json"),
      include: [],
      files: [snippet, path.join(TYPES_DIR, "webflow.ts"), path.join(SUPPORT_DIR, "globals.d.ts")],
    }),
  );
  const check = Bun.spawnSync([tsc, "-p", config], { stdout: "pipe", stderr: "pipe" });
  fs.rmSync(config, { force: true });
  if (check.exitCode !== 0) {
    await mcp.client.close();
    console.error(`${check.stdout.toString()}${check.stderr.toString()}`.trim());
    console.error("[wf-mcp] The snippet failed the typecheck, so it didn't run. Fix it, or pass --no-check to run it anyway.");
    process.exit(2);
  }
}

const counts: Record<Access | "blocked", number> = { read: 0, sensitive: 0, write: 0, destructive: 0, blocked: 0 };
const uploads = new UploadTargets();
// The structure of each action's results this run, merged into shapes.json at the end (shapes.ts).
const shapes = new Map<string, Shape>();

// Most inputs are objects; a few designer_tool actions take `true`.
type Request = { tool: string; action: string | null; input: unknown; toolArgs: Record<string, unknown> };

// Map a snippet call to the tool arguments and its access level from the access table.
function resolve(req: Request): { name: string; access: Access; args: Record<string, unknown> } {
  const { tool, action } = req;
  const entry = levels.tools[tool];
  if (!entry) throw new Error(`Unknown tool ${tool}. See types/index.md.`);
  if (entry.kind === "call") {
    if (action) throw new Error(`${tool} has no actions; call it as webflow.${tool}(input).`);
    return { name: tool, access: entry.access, args: req.input as Record<string, unknown> };
  }
  if (!action) throw new Error(`${tool} takes actions; call it as webflow.${tool}.<action>(input).`);
  const access = entry.actions[action];
  if (!access) throw new Error(`Unknown action ${tool}.${action}. See types/${tool}.ts.`);
  return { name: `${tool}.${action}`, access, args: { ...req.toolArgs, actions: [{ label: action, [action]: req.input }] } };
}

// The user's answer for each `tool.action` and site this run, so they're asked once per action. Prompts go one at
// a time. Write and sensitive actions the user chose to always allow (trust.ts) skip the prompt.
const approvals = new Map<string, Promise<{ ok: boolean; how: string }>>();
const askOne = limiter(1);

// Site names for the approval prompt, listed once per run when the first prompt needs one. A failed lookup
// leaves the prompt showing the site ID.
let siteNames: Promise<Map<string, string>> | undefined;
async function siteName(id: string): Promise<string | undefined> {
  siteNames ??= callOutput(mcp, "data_sites_tool", { actions: [{ label: "sites", list_sites: {} }] }, mcp.context, {
    signal: stopRun.signal,
    admit: limit,
  })
    .then(({ text }) => {
      const result = unwrap("data_sites_tool.list_sites", text) as { sites?: Array<{ id: string; displayName: string }> };
      return new Map((result?.sites ?? []).map((s) => [s.id, s.displayName]));
    })
    .catch(() => new Map());
  return (await siteNames).get(id);
}

function approve(name: string, access: Access, req: Request): Promise<{ ok: boolean; how: string }> {
  const input = req.input as Record<string, unknown> | undefined;
  const site = [req.toolArgs?.siteId, req.toolArgs?.site_id, input?.siteId, input?.site_id].find((v) => typeof v === "string") as
    | string
    | undefined;
  const key = `${name}|${site ?? "*"}`;
  let decision = approvals.get(key);
  if (!decision) {
    decision = askOne(async () => {
      if (isRemembered(name, site, access)) return { ok: true, how: `always allowed for ${APPROVAL_DAYS} days; \`wf-mcp approvals --clear\` revokes it` };
      hold();
      try {
        const answer = await confirmCall({
          snippet: path.basename(snippet),
          name,
          access,
          site,
          siteName: site && (await siteName(site)),
          input: req.input,
          canRemember: rememberable(access),
        });
        if (answer.remember) remember(name, site, access);
        const scope = answer.remember ? `for ${APPROVAL_DAYS} days${site ? ` on site ${site}` : ""}` : "for this run";
        console.error(`[wf-mcp] ${answer.ok ? "Allowed" : "Denied"} ${name} ${scope} (${answer.how}).`);
        return answer;
      } finally {
        release();
      }
    });
    approvals.set(key, decision);
  }
  return decision;
}

async function handle(req: Request): Promise<unknown> {
  const { name, access, args } = resolve(req);
  if (!allowed.has(access)) {
    counts.blocked++;
    throw new Error(`Blocked ${name}: it is a ${access} call and this run allows ${[...allowed].join(", ")}. Rerun with --allow ${access} if intended.`);
  }
  if (access !== "read") {
    const { ok, how } = await approve(name, access, req);
    if (!ok) {
      counts.blocked++;
      throw new Error(`Denied ${name}: the user didn't approve this ${access} call (${how}). Don't retry it without asking them.`);
    }
  }
  counts[access]++;

  // Reads that reach Webflow and fail with a 429, or a 401 partway, are sent again. Writes are not, since a tool may
  // have applied part of the change already. At most --concurrency requests are out at once, fewer while Webflow is
  // rate limiting the run; a call gives up its slot while it waits out a pause or a login recovery. A call still
  // waiting when the run stops is never sent.
  const output = await callOutput(mcp, req.tool, args, mcp.context, { resend: access === "read", signal: stopRun.signal, admit: limit });
  const { text } = output;
  const value = req.action ? unwrap(name, text) : parseMaybe(text);
  uploads.record(name, value);
  // Images (element snapshots) are saved to out/ and returned as paths, which the agent can open.
  const images = output.images.map((image, i) => {
    const file = path.join(OUT_DIR, `${req.tool}-${Date.now()}-${i}.${image.mimeType.split("/")[1] ?? "png"}`);
    fs.writeFileSync(file, Buffer.from(image.data, "base64"));
    return file;
  });
  const returned = images.length ? { images, result: value } : value;
  // Sensitive results (form submissions, members, logs) can be keyed by personal data, so their shapes aren't kept.
  if (access !== "sensitive") shapes.set(name, merge(shapes.get(name), shapeOf(returned)));
  return returned;
}

// One action's result. Data tools answer {label, action, result | error}; tools that go through the Designer
// bridge (designer_tool) answer a list with one {status, message, data} per action.
function unwrap(name: string, text: string): unknown {
  const parsed = JSON.parse(text) as unknown;
  const r = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return parsed;
  const describe = (e: unknown) =>
    typeof e === "string" ? e : ((e as { message?: string } | undefined)?.message ?? JSON.stringify(e));
  if ("label" in r || "action" in r) {
    if (r.error) throw new Error(`${name}: ${describe(r.error)}`);
    return r.result;
  }
  if ("status" in r) {
    if (r.status === false || r.status === "error") throw new Error(`${name}: ${describe(r.error ?? r.message ?? r)}`);
    return r.data;
  }
  return parsed;
}

function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let output = "";
started = true;
startTimer();
const result = await runSandboxed(
  code,
  {
    args: positionals.slice(1),
    outDir: OUT_DIR,
    call: (tool, action, input, toolArgs) => handle({ tool, action, input, toolArgs: toolArgs as Record<string, unknown> }),
    upload: async (file, target) => {
      const result = await uploads.upload(file, target);
      console.error(`[wf-mcp] Uploaded ${path.basename(file)} (${result.bytes} bytes).`);
      return result;
    },
    print: (text) => {
      output += `${text}\n`;
    },
    // Past the deadline, stop the run the same way the timer does, so calls waiting to be sent see it at once.
    shouldStop: () => {
      if (Date.now() > deadline) expire();
      return timedOut;
    },
  },
  stopRun.signal,
);
clearTimeout(timer);
await mcp.client.close();

// Recording shapes only helps later sessions, so a failure to save them doesn't fail the run.
try {
  const added = saveShapes(shapes);
  if (added.length) console.error(`[wf-mcp] Recorded what ${added.join(", ")} returned: \`wf-mcp types <tool>.<action>\` now shows it.`);
} catch (err) {
  console.error(`[wf-mcp] Couldn't save the response shapes: ${errorMessage(err)}`);
}

// Long output keeps its start and its end; the full log is saved.
if (output.length > maxOutput) {
  const log = path.join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  fs.writeFileSync(log, output);
  const note = (omitted: number) =>
    `[wf-mcp] … ${omitted} of ${output.length} characters omitted here. Full log: ${log}`;
  process.stdout.write(truncateMiddle(output, maxOutput, note));
} else process.stdout.write(output);
const longNote = longOutputNote(output);
if (longNote) console.error(longNote);

const exitCode = result === "stopped" ? 124 : result === "error" ? 1 : 0;
const tally = [...ACCESS_LEVELS, "blocked" as const].filter((l) => counts[l]).map((l) => `${l} ${counts[l]}`);
const { hits } = mcp.rateGate;
const paused = Math.round(mcp.rateGate.cooldownMs(stoppedAt) / 1000);
const limited = hits ? ` Rate limited ${hits} time${hits === 1 ? "" : "s"}; pauses lasted ${paused}s in all.` : "";
// Rate-limit pauses count toward the timeout.
const timeoutNote = !timedOut
  ? ""
  : paused
    ? ` Timed out after ${opts.timeout}s, ${paused}s of them in rate-limit pauses: try a longer --timeout or a lower --concurrency.`
    : ` Timed out after ${opts.timeout}s.`;
console.error(`[wf-mcp] Calls: ${tally.length ? tally.join(", ") : "none"}.${limited}${timeoutNote} Exit ${exitCode}.`);
process.exit(exitCode);
