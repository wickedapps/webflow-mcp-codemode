// Print the generated types for single actions, so a session reads one action's inputs instead of a whole tool's
// file (some are over 20,000 characters).
//   wf-mcp types data_cms_tool.list_collection_items [more.actions...]
//   wf-mcp types data_cms_tool          the tool's description and its actions by access level
import fs from "node:fs";
import path from "node:path";
import { readManifest } from "./gen-types.ts";
import { ACCESS_LEVELS } from "./access.ts";
import { TYPES_DIR } from "./paths.ts";

const MEMBER = /^  (\w+)<T = unknown>\(/;
const MEMBER_START = /^  (\/\*\*|\w+<T = unknown>\()/;

// One action's JSDoc and signature from a generated tool file (gen-types.ts writes members at a two-space indent).
export function actionDoc(source: string, action: string): string | undefined {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => MEMBER.exec(l)?.[1] === action);
  if (at < 0) return;
  let start = at;
  if (lines[at - 1]?.startsWith("  /**")) start = at - 1;
  else if (lines[at - 1]?.trim() === "*/") {
    start = at - 1;
    while (start > 0 && !lines[start]?.startsWith("  /**")) start--;
  }
  let end = at + 1;
  for (; end < lines.length; end++) {
    const line = lines[end] ?? "";
    if (MEMBER_START.test(line) || line.startsWith("}")) break;
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

export function actionNames(source: string): string[] {
  return source.split("\n").flatMap((l) => MEMBER.exec(l)?.[1] ?? []);
}

// What `wf-mcp types <name>` prints, or an error message.
export function describeType(name: string): { ok: boolean; text: string } {
  const [tool = "", action] = name.split(".");
  const file = path.join(TYPES_DIR, `${tool}.ts`);
  if (!/^\w+$/.test(tool) || !fs.existsSync(file)) return { ok: false, text: `No tool ${tool}. See ${path.join(TYPES_DIR, "index.md")}.` };
  const source = fs.readFileSync(file, "utf8");
  const actions = actionNames(source);
  // A tool without actions is one short signature.
  if (!actions.length) return action ? { ok: false, text: `${tool} has no actions; call it as webflow.${tool}(input).` } : { ok: true, text: source.trimEnd() };
  if (action) {
    const doc = actionDoc(source, action);
    return doc ? { ok: true, text: `// ${tool}\n${doc}` } : { ok: false, text: `No action ${tool}.${action}. Its actions: ${actions.join(", ")}.` };
  }
  const intro = source.slice(0, source.indexOf("export interface")).replace(/^\/\/ Generated.*\n\n?/, "").trimEnd();
  const entry = readManifest()?.tools[tool];
  const byLevel =
    entry?.kind === "actions"
      ? ACCESS_LEVELS.flatMap((level) => {
          const names = actions.filter((a) => entry.actions[a] === level);
          return names.length ? [`- ${level}: ${names.join(", ")}`] : [];
        })
      : [`- actions: ${actions.join(", ")}`];
  return { ok: true, text: [intro, ...byLevel, `\`wf-mcp types ${tool}.<action>\` prints one action's inputs.`].join("\n") };
}
