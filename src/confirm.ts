// Ask the person at the computer to approve a call before the runner makes it. The agent that runs a snippet
// chooses its --allow flags, so those can't be the only check: this asks outside the agent's reach, in the
// terminal when there is one, otherwise in a macOS dialog. Anything else, including no answer, means no.
// For write and sensitive actions the user can also choose "Always allow" (`remember`), which trust.ts keeps.
import readline from "node:readline/promises";
import { APPROVAL_DAYS } from "./trust.ts";

export interface ConfirmRequest {
  snippet: string;
  // `tool.action`, or the tool name for tools without actions.
  name: string;
  access: string;
  site?: string;
  // The site's display name, when it could be looked up.
  siteName?: string;
  input: unknown;
  // Offer "Always allow" for this action on this site. Off for destructive actions.
  canRemember?: boolean;
}

export interface ConfirmAnswer {
  ok: boolean;
  how: string;
  // The user chose "Always allow".
  remember?: boolean;
}

const DIALOG_SECONDS = 120;

// The message and button list are passed as arguments, never spliced into the script, so snippet input can't
// inject AppleScript. Buttons are separated by "|".
const DIALOG_SCRIPT = `on run argv
  set AppleScript's text item delimiters to "|"
  set choices to text items of (item 3 of argv)
  set reply to display dialog (item 1 of argv) with title "Webflow MCP runner" buttons choices default button "Deny" cancel button "Deny" giving up after (item 2 of argv as integer) with icon caution
  if gave up of reply then return "timeout"
  return button returned of reply
end run`;

const UPPER = new Set(["cms", "seo", "aeo", "ai", "url", "html", "whtml", "css", "dom", "id"]);
// Tool areas that the action's own words don't name, so they're added after the verb.
const AREAS: Record<string, string> = {
  cms: "cms",
  apps: "app",
  campaigns: "campaign",
  localization: "localization",
  comments: "comment",
  element: "element",
  element_settings: "element",
};

const words = (s: string) => s.split("_").filter(Boolean);
const phrase = (ws: string[]) =>
  ws
    .map((w) => (UPPER.has(w) ? w.toUpperCase() : w))
    .join(" ")
    .replace("robots txt", "robots.txt");

// "data_cms_tool.update_collection_items" -> verb "update", object "CMS items".
// Calls whose names don't read as what they do.
const PHRASES: Record<string, { verb: string; object: string }> = {
  get_more_tools: { verb: "send", object: "a description of this task to Webflow's team" },
};

export function actionWords(name: string): { verb: string; object: string; noun?: string } {
  if (PHRASES[name]) return PHRASES[name];
  const [tool, action] = name.split(".");
  const area = words(tool).filter((w) => w !== "data" && w !== "tool").join("_");
  if (!action) return { verb: "use", object: phrase(words(area)) };
  let ws = words(action);
  if (ws[0] === "bulk" || ws[0] === "batch") ws = ws.slice(1);
  if (ws[0] === "unlink" && ws[1] === "delete") ws = ["unlink and delete", ...ws.slice(2)];
  const [verb, ...rest] = ws;
  let object = rest;
  // CMS actions say "collection" before what they change: collection items are CMS items.
  if (area === "cms" && object[0] === "collection" && object.length > 1) object = object.slice(1);
  const extra = AREAS[area];
  if (extra && !object.some((w) => w.startsWith(extra))) object = [extra, ...object];
  return { verb, object: phrase(object), noun: rest.at(-1) };
}

const thirdPerson = (verb: string) => (/(s|sh|ch|x)$/.test(verb) ? `${verb}es` : `${verb}s`);

// How many things this call changes: the length of the array named after the action's last word (`items` for
// update_collection_items, `pages` for bulk_update_pages), within the first few levels of the input.
export function changeCount(input: unknown, noun: string | undefined): number | undefined {
  if (!noun?.endsWith("s")) return;
  const search = (value: unknown, depth: number): number | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return;
    const found = (value as Record<string, unknown>)[noun];
    if (Array.isArray(found)) return found.length;
    for (const v of Object.values(value)) {
      const n = search(v, depth + 1);
      if (n !== undefined) return n;
    }
  };
  return search(input, 0);
}

export function describe(req: ConfirmRequest): string {
  const { verb, object, noun } = actionWords(req.name);
  const what = `${verb} ${object}`;
  const site = req.siteName ?? req.site;
  const here = site ? " on this site" : "";
  const count = changeCount(req.input, noun);
  const unit = count === 1 ? noun!.slice(0, -1) : noun;
  return [
    `${req.snippet} wants to ${what}${site ? ` on ${site}` : ""}.`,
    "",
    ...(count !== undefined ? [`This call ${thirdPerson(verb)} ${count} ${unit}.`] : []),
    req.canRemember
      ? `Allow this run lets this snippet ${what}${here} until it finishes. Always allow lets any snippet do it for ${APPROVAL_DAYS} days.`
      : `Allow lets this snippet ${what}${here} until it finishes.`,
  ].join("\n");
}

export async function confirmCall(req: ConfirmRequest, dialogSeconds = DIALOG_SECONDS): Promise<ConfirmAnswer> {
  const message = describe(req);
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`\n${message}\n${req.canRemember ? "Allow? [y = this run, a = always, N]" : "Allow? [y/N]"} `)).trim();
    rl.close();
    if (req.canRemember && /^a(lways)?$/i.test(answer)) return { ok: true, how: "terminal", remember: true };
    return { ok: /^y(es)?$/i.test(answer), how: "terminal" };
  }
  const buttons = req.canRemember ? "Deny|Allow this run|Always allow" : "Deny|Allow";
  const proc = Bun.spawn(["/usr/bin/osascript", "-e", DIALOG_SCRIPT, message, String(dialogSeconds), buttons], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [reply] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const answer = reply.trim();
  if (answer === "Always allow") return { ok: true, how: "dialog", remember: true };
  if (answer === "Allow" || answer === "Allow this run") return { ok: true, how: "dialog" };
  return { ok: false, how: answer === "timeout" ? `no answer within ${dialogSeconds}s` : "dialog" };
}
