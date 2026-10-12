// Where the runner keeps its state. The compiled binary has no source folder of its own, so the login, the
// approvals, the generated types, snippets and results all live in one home folder:
//   1. $WF_MCP_HOME, when set;
//   2. the nearest .wf-mcp/ folder in the working directory or a parent of it, so each project can have its
//      own login (`wf-mcp init` creates one);
//   3. ~/.wf-mcp, shared by every project without one of its own.
// Any home other than ~/.wf-mcp, whether found as a project's .wf-mcp/ or named by $WF_MCP_HOME, is only used
// if `wf-mcp init` created or adopted it on this machine, for this user (projectHomeTrusted). Otherwise a cloned
// repo or a zip could ship one with approvals in it, and a repo's .claude/settings.json can set $WF_MCP_HOME.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_NAME = ".wf-mcp";
export const GLOBAL_HOME = path.join(os.homedir(), HOME_NAME);

// The nearest .wf-mcp/ folder in `dir` or one of its parents. Reaching ~ finds ~/.wf-mcp, the global home.
export function findProjectHome(dir: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const candidate = path.join(d, HOME_NAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    if (path.dirname(d) === d) return undefined;
  }
}

export const HOME = path.resolve(process.env.WF_MCP_HOME || findProjectHome(process.cwd()) || GLOBAL_HOME);
// Where the home came from, for `wf-mcp home` and the login message.
export const HOME_SOURCE = process.env.WF_MCP_HOME ? "$WF_MCP_HOME" : HOME === GLOBAL_HOME ? "global" : "project";

// `wf-mcp init` signs a project's home with a key only this user has (in ~/.wf-mcp), bound to the folder's path.
// A .wf-mcp/ folder made anywhere else, or moved, has no valid signature and isn't used until it's adopted.
const KEY_FILE = path.join(GLOBAL_HOME, ".project-key");
const MARKER = ".owner";

const sign = (key: Buffer, home: string) => createHmac("sha256", key).update(fs.realpathSync(home)).digest();

export function signProjectHome(home: string): void {
  if (!fs.existsSync(KEY_FILE)) {
    fs.mkdirSync(GLOBAL_HOME, { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  }
  const key = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
  fs.writeFileSync(path.join(home, MARKER), sign(key, home).toString("hex") + "\n", { mode: 0o600 });
}

export function projectHomeTrusted(home: string): boolean {
  try {
    const key = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
    const mark = Buffer.from(fs.readFileSync(path.join(home, MARKER), "utf8").trim(), "hex");
    const expected = sign(key, home);
    return mark.length === expected.length && timingSafeEqual(mark, expected);
  } catch {
    return false;
  }
}

// Only ~/.wf-mcp is trusted as is; every other home has to be signed, including one named by $WF_MCP_HOME, which
// project settings or a .envrc could point at a folder that came with the repo.
export const HOME_TRUSTED = HOME === GLOBAL_HOME || projectHomeTrusted(HOME);
// Write and sensitive actions the user chose to always allow (trust.ts).
export const APPROVALS_FILE = path.join(HOME, "approvals.json");
export const TYPES_DIR = path.join(HOME, "types");
export const OUT_DIR = path.join(HOME, "out");
export const SNIPPETS_DIR = path.join(HOME, "snippets");
// Typechecking support files, written by ensureHome(): the sandbox's globals and the snippets' tsconfig.
export const SUPPORT_DIR = path.join(HOME, "support");

// The native TypeScript compiler ships next to the binary in typescript-<os>-<arch>/, with the lib.*.d.ts files
// it needs beside it. $WF_MCP_TSC overrides it.
export function tscPath(): string | undefined {
  const candidates = [
    process.env.WF_MCP_TSC,
    path.join(path.dirname(process.execPath), `typescript-${process.platform}-${process.arch}`, "tsc"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p));
}
