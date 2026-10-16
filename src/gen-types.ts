// Generate TypeScript types for the Webflow MCP tools, one file per tool, so snippets can be typechecked
// and readers can open only the tools they need.
//   wf-mcp gen
// Writes types/<tool>.ts, types/webflow.ts (the global `webflow` object), types/index.md (a short catalog)
// and types/manifest.json (schema hashes and each action's access level, used by run.ts).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ACCESS_LEVELS, actionAccess, toolAccess, type Access } from "./access.ts";
import { connect } from "./client.ts";
import { TYPES_DIR } from "./paths.ts";

export { TYPES_DIR };

// `guessed` lists the actions whose level came from their name, not from OVERRIDES in access.ts.
export type ToolEntry =
  | { kind: "actions"; hash: string; toolArgs: string[]; actions: Record<string, Access>; guessed: string[] }
  | { kind: "call"; hash: string; access: Access };
export interface Manifest {
  generatedAt: string;
  hash: string;
  // How this binary writes types/ (TYPES_FORMAT); missing in types written before it was added.
  format?: number;
  tools: Record<string, ToolEntry>;
}

// Bump when the generated files change shape (say, what index.md shows), so existing homes are rewritten even
// though Webflow's schemas haven't changed.
export const TYPES_FORMAT = 3;

// Why types/ needs writing for this tools/list result, if it does: Webflow's schemas changed, or only the way
// this binary writes them.
export function staleTypes(manifest: Manifest | undefined, tools: Tool[]): "schemas" | "format" | undefined {
  if (manifest?.hash !== schemaHash(tools)) return "schemas";
  if (manifest.format !== TYPES_FORMAT) return "format";
  return undefined;
}

const MANIFEST = path.join(TYPES_DIR, "manifest.json");
// Every call gets these from client.ts, so they are left out of the generated signatures.
const SESSION_ARGS = new Set(["session_id", "agent_id", "context"]);

type Schema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  additionalProperties?: boolean | Schema;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const pascal = (name: string) => name.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function jsdoc(text: string | undefined, indent: string): string {
  if (!text?.trim()) return "";
  const lines = text.trim().replace(/\*\//g, "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join("\n")}\n${indent} */\n`;
}

function toTs(s: Schema | boolean | undefined, indent: string): string {
  if (!s || s === true) return "unknown";
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(" | ");
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map((x) => toTs(x, indent)).join(" | ");
  if (s.allOf) return s.allOf.map((x) => `(${toTs(x, indent)})`).join(" & ");
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties ? ["object"] : [];
  if (!types.length) return "unknown";
  return types
    .map((t) => {
      if (t === "array") return `Array<${toTs(s.items, indent)}>`;
      if (t === "object") return objectTs(s, indent);
      if (t === "integer") return "number";
      return ["string", "number", "boolean", "null"].includes(t) ? t : "unknown";
    })
    .join(" | ");
}

// An input Webflow describes as deprecated ("Deprecated: …", "Deprecated earlier shape: …"). It's left out of the
// types unless it's required, so a snippet that uses one fails the typecheck and moves to what replaced it: a
// comment saying "deprecated" is easy to miss, and tsc doesn't report @deprecated.
const deprecated = (s: Schema) => /^\s*deprecated\b/i.test(s.description ?? "");

export function objectTs(s: Schema, indent: string, omit = new Set<string>()): string {
  const required = new Set(s.required ?? []);
  const all = Object.entries(s.properties ?? {}).filter(([k]) => !omit.has(k));
  const props = all.filter(([k, v]) => required.has(k) || !deprecated(v));
  // Only deprecated inputs: nothing is left to pass.
  if (all.length && !props.length) return "Record<string, never>";
  if (!props.length) {
    return typeof s.additionalProperties === "object"
      ? `Record<string, ${toTs(s.additionalProperties, indent)}>`
      : "Record<string, unknown>";
  }
  const lines = props.map(
    ([k, v]) => `${jsdoc(v.description, indent + "  ")}${indent}  ${key(k)}${required.has(k) ? "" : "?"}: ${toTs(v, indent + "  ")};`,
  );
  return `{\n${lines.join("\n")}\n${indent}}`;
}

// A tool is action-style when `actions` items each hold `label` plus exactly one action key.
function actionVariants(tool: Tool): Array<[string, Schema]> | undefined {
  const items = (tool.inputSchema.properties?.actions as Schema | undefined)?.items;
  if (!items) return;
  const variants = items.anyOf ?? [items];
  const out: Array<[string, Schema]> = [];
  for (const v of variants) {
    const entries = Object.entries(v.properties ?? {}).filter(([k]) => k !== "label");
    if (entries.length !== 1) return;
    out.push(entries[0]!);
  }
  return out;
}

function toolFile(tool: Tool): { source: string; entry: ToolEntry } {
  const schema = tool.inputSchema as Schema;
  const variants = actionVariants(tool);
  const header = `// Generated by gen-types.ts from the ${tool.name} schema. Do not edit; run \`wf-mcp gen\`.\n\n`;
  const toolHash = hash({ d: tool.description, s: tool.inputSchema, a: tool.annotations });

  if (!variants) {
    const access = toolAccess(tool.name, tool.annotations?.readOnlyHint);
    const input = objectTs(schema, "", SESSION_ARGS);
    const optional = !(schema.required ?? []).some((k) => !SESSION_ARGS.has(k));
    const source =
      header +
      jsdoc(`${tool.description ?? ""}\n\nAccess: ${access}.`, "") +
      `export type ${pascal(tool.name)} = <T = unknown>(input${optional ? "?" : ""}: ${input}) => Promise<T>;\n`;
    return { source, entry: { kind: "call", hash: toolHash, access } };
  }

  const toolArgs = Object.keys(schema.properties ?? {}).filter((k) => k !== "actions" && !SESSION_ARGS.has(k));
  const toolArgsRequired = toolArgs.some((k) => schema.required?.includes(k));
  const toolArgsTs = toolArgs.length
    ? objectTs({ properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => toolArgs.includes(k))), required: schema.required }, "  ")
    : "";
  const actions: Record<string, Access> = {};
  const guessed: string[] = [];
  const members = variants.map(([action, s]) => {
    const level = actionAccess(tool.name, action);
    const access = (actions[action] = level.access);
    if (level.guessed) guessed.push(action);
    // Most actions take an object; a few take a boolean flag (designer_tool) or a union of objects.
    const isObject = s.type === "object" || (!s.type && !s.anyOf && !s.oneOf);
    const inputOptional = isObject && !toolArgsRequired && !(s.required ?? []).length;
    const params = [`input${inputOptional ? "?" : ""}: ${isObject ? objectTs(s, "  ") : toTs(s, "  ")}`];
    if (toolArgs.length) params.push(`tool${toolArgsRequired ? "" : "?"}: ${toolArgsTs}`);
    return `${jsdoc(`${s.description ?? ""}\n\nAccess: ${access}.`, "  ")}  ${action}<T = unknown>(${params.join(", ")}): Promise<T>;`;
  });
  const source = header + jsdoc(tool.description, "") + `export interface ${pascal(tool.name)} {\n${members.join("\n")}\n}\n`;
  return { source, entry: { kind: "actions", hash: toolHash, toolArgs, actions, guessed } };
}

// Whether an action's input lets Webflow filter or sort the results, within its first few levels (CMS items keep
// them under `request`). The catalog marks these, so a snippet narrows results on Webflow's side instead of
// reading everything and filtering in code.
export function narrowing(schema: Schema | undefined, depth = 0): Array<"filter" | "sort"> {
  if (!schema || depth > 3) return [];
  const found = new Set<"filter" | "sort">();
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    if (k === "filter" || k === "filters") found.add("filter");
    if (k === "sort" || k === "sortBy") found.add("sort");
    for (const f of narrowing(v, depth + 1)) found.add(f);
  }
  return (["filter", "sort"] as const).filter((f) => found.has(f));
}

function catalog(tools: Tool[], manifest: Manifest): string {
  const lines = [
    "# Webflow MCP tools",
    "",
    `Generated ${manifest.generatedAt} by \`wf-mcp gen\`. Full signatures and docs: \`types/<tool>.ts\`.`,
    "Call from a snippet as `webflow.<tool>.<action>(input, tool?)`, or `webflow.<tool>(input)` for tools without actions.",
    "Snippets may make read calls by default; the other levels need `--allow sensitive`, `--allow write` or `--allow destructive`.",
    "Reads marked (filter) or (sort) can narrow or order results on Webflow's side: use that instead of reading everything and filtering in the snippet.",
  ];
  for (const tool of tools) {
    const entry = manifest.tools[tool.name];
    if (!entry) continue;
    const first = (tool.description ?? "").split("\n")[0] ?? "";
    const summary = first.length > 200 ? `${first.slice(0, first.lastIndexOf(" ", 200))}…` : first;
    lines.push("", `## ${tool.name}`, summary);
    if (entry.kind === "call") {
      lines.push(`- call directly; access: ${entry.access}`);
      continue;
    }
    if (entry.toolArgs.length) lines.push(`- tool args: ${entry.toolArgs.join(", ")}`);
    const schemas = new Map(actionVariants(tool));
    for (const level of ACCESS_LEVELS) {
      const names = Object.keys(entry.actions)
        .filter((a) => entry.actions[a] === level)
        .map((a) => {
          const marks = level === "read" || level === "sensitive" ? narrowing(schemas.get(a)) : [];
          return marks.length ? `${a} (${marks.join(", ")})` : a;
        });
      if (names.length) lines.push(`- ${level}: ${names.join(", ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function schemaHash(tools: Tool[]): string {
  return hash([...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, t.description, t.inputSchema, t.annotations]));
}

// The manifest for a tools/list result, without writing anything. run.ts takes each call's access level from
// this, computed by the binary's own access table, never from types/manifest.json on disk, which anyone who
// can write to the home folder could edit to make a destructive action look like a read.
export function buildManifest(tools: Tool[]): Manifest {
  const manifest: Manifest = { generatedAt: new Date().toISOString(), hash: schemaHash(tools), tools: {} };
  for (const tool of tools) manifest.tools[tool.name] = toolFile(tool).entry;
  return manifest;
}

export function readManifest(): Manifest | undefined {
  return fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : undefined;
}

// Regenerate types/ from a tools/list result and return the new manifest. The files are written to a new
// folder that then replaces types/, so a run reading types/ meanwhile sees either the old set or the new one.
export function writeTypes(tools: Tool[]): Manifest {
  const dir = `${TYPES_DIR}.new-${process.pid}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Manifest = { generatedAt: new Date().toISOString(), hash: schemaHash(tools), format: TYPES_FORMAT, tools: {} };
  for (const tool of tools) {
    const { source, entry } = toolFile(tool);
    manifest.tools[tool.name] = entry;
    fs.writeFileSync(path.join(dir, `${tool.name}.ts`), source);
  }
  const imports = tools.map((t) => `import type { ${pascal(t.name)} } from "./${t.name}.ts";`);
  const members = tools.map((t) => `  ${t.name}: ${pascal(t.name)};`);
  fs.writeFileSync(
    path.join(dir, "webflow.ts"),
    `// Generated by gen-types.ts. Do not edit; run \`wf-mcp gen\`.\n${imports.join("\n")}\n\n` +
      `export interface Webflow {\n${members.join("\n")}\n}\n\n` +
      `declare global {\n  // Provided by run.ts inside a snippet.\n  const webflow: Webflow;\n}\n`,
  );
  fs.writeFileSync(path.join(dir, "index.md"), catalog(tools, manifest));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const old = `${TYPES_DIR}.old-${process.pid}`;
  if (fs.existsSync(TYPES_DIR)) fs.renameSync(TYPES_DIR, old);
  fs.renameSync(dir, TYPES_DIR);
  fs.rmSync(old, { recursive: true, force: true });
  return manifest;
}

// Describe what changed between two manifests, one line per tool. New actions whose access level was
// guessed from their name are listed separately, so they can be checked and added to access.ts.
export function diffManifests(before: Manifest | undefined, after: Manifest): string[] {
  if (!before) return ["no previous types"];
  const out: string[] = [];
  const guesses: string[] = [];
  for (const name of Object.keys(before.tools)) if (!after.tools[name]) out.push(`removed tool ${name}`);
  for (const [name, entry] of Object.entries(after.tools)) {
    const old = before.tools[name];
    const oldActions = old?.kind === "actions" ? Object.keys(old.actions) : [];
    const newActions = entry.kind === "actions" ? Object.keys(entry.actions) : [];
    const added = newActions.filter((a) => !oldActions.includes(a));
    if (entry.kind === "actions") {
      for (const a of added) if (entry.guessed.includes(a)) guesses.push(`${name}.${a}: ${entry.actions[a]}`);
    } else if (!old) guesses.push(`${name}: ${entry.access}`);
    if (!old) out.push(`added tool ${name}`);
    else if (old.hash !== entry.hash) {
      const removed = oldActions.filter((a) => !newActions.includes(a));
      const detail = [added.length ? `+${added.join(", +")}` : "", removed.length ? `-${removed.join(", -")}` : ""].filter(Boolean);
      out.push(`changed ${name}${detail.length ? ` (${detail.join("; ")})` : " (schema details)"}`);
    }
  }
  if (guesses.length) out.push(`check these levels, guessed from names (add them to access.ts): ${guesses.join(", ")}`);
  if (!out.length) out.push("no differences in any one tool (only the overall schema hash)");
  return out;
}

export async function generate(): Promise<void> {
  fs.mkdirSync(path.dirname(TYPES_DIR), { recursive: true });
  const mcp = await connect({ name: "wf-mcp-gen" });
  const { tools } = await mcp.client.listTools();
  await mcp.client.close();
  const before = readManifest();
  const after = writeTypes(tools);
  const actions = Object.values(after.tools).reduce((n, t) => n + (t.kind === "actions" ? Object.keys(t.actions).length : 1), 0);
  console.log(`Wrote ${TYPES_DIR} for ${tools.length} tools, ${actions} callable functions.`);
  for (const line of diffManifests(before, after)) console.log(`  ${line}`);
}
