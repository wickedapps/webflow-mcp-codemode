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
const INPUT_PREVIEW = 400;

// The message and button list are passed as arguments, never spliced into the script, so snippet input can't
// inject AppleScript. Buttons are separated by "|".
const DIALOG_SCRIPT = `on run argv
  set AppleScript's text item delimiters to "|"
  set choices to text items of (item 3 of argv)
  set reply to display dialog (item 1 of argv) with title "Webflow MCP runner" buttons choices default button "Deny" cancel button "Deny" giving up after (item 2 of argv as integer) with icon caution
  if gave up of reply then return "timeout"
  return button returned of reply
end run`;

export function describe(req: ConfirmRequest): string {
  let input = JSON.stringify(req.input) ?? "";
  if (input.length > INPUT_PREVIEW) input = `${input.slice(0, INPUT_PREVIEW)}… (${input.length} characters)`;
  return [
    `The snippet ${req.snippet} wants to make a ${req.access} call:`,
    "",
    req.name,
    ...(req.site ? [`Site: ${req.site}`] : []),
    `Input: ${input}`,
    "",
    req.canRemember
      ? `Allow this action for this run, or always${req.site ? " on this site" : ""} (for ${APPROVAL_DAYS} days)? Nothing is sent until you choose. Deny if you didn't expect it.`
      : "Allow this action for the rest of this run? Nothing is sent until you choose. Deny if you didn't expect it.",
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
