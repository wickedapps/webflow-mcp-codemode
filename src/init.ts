// Give a project its own home folder (paths.ts), so it gets its own Webflow login, approvals, snippets and results.
//   wf-mcp init [dir]
// Creates .wf-mcp/ in `dir`; or, with $WF_MCP_HOME set, the folder it names; or else .wf-mcp/ at the root of the
// git repository holding the working directory, or in the working directory. Then signs it for this user (paths.ts). The folder ignores itself in git, so the login
// inside can't be committed by accident.
//
// Run on a .wf-mcp/ folder that isn't signed for this user (it came with a repo or a zip, or was moved), init
// adopts it: any login for it in the Keychain, the approvals and the generated types are deleted first, since whoever made the
// folder chose them. Snippets and results are kept.
import fs from "node:fs";
import path from "node:path";
import { forgetLogin } from "./credentials.ts";
import { HOME_NAME, projectHomeTrusted, signProjectHome } from "./paths.ts";
import { howToRun } from "./plugin.ts";

// What adopting a folder removes: anything that can skip a prompt or describe actions.
const UNTRUSTED = ["approvals.json", "types"];

function projectRoot(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  const top = git.exitCode === 0 ? git.stdout.toString().trim() : "";
  return top || process.cwd();
}

// The folder init sets up: .wf-mcp/ in `dir`; else the folder $WF_MCP_HOME names, itself; else .wf-mcp/ at the
// project root.
function target(dir?: string): string {
  if (dir) return path.join(path.resolve(dir), HOME_NAME);
  if (process.env.WF_MCP_HOME) return path.resolve(process.env.WF_MCP_HOME);
  return path.join(projectRoot(), HOME_NAME);
}

export function init(dir?: string): string {
  const home = target(dir);
  if (fs.existsSync(home) && projectHomeTrusted(home)) {
    console.log(`${home} is already this project's home.`);
    return home;
  }
  const adopting = fs.existsSync(home);
  const removed = adopting ? UNTRUSTED.filter((name) => fs.existsSync(path.join(home, name))) : [];
  for (const name of removed) fs.rmSync(path.join(home, name), { recursive: true, force: true });
  // A Keychain login under this path belongs to whatever project was here before, not to this folder.
  if (adopting) forgetLogin(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".gitignore"), "# Holds a personal Webflow login: never commit it.\n*\n");
  signProjectHome(home);
  if (adopting) {
    console.log(`Adopted ${home}, which wasn't set up by you on this machine.`);
    if (removed.length) console.log(`Removed what its creator chose: ${removed.join(", ")}.`);
  } else console.log(`Created ${home}. Runs from this project now use it.`);
  console.log(`Next, to log in for this project, ${howToRun("login")}.`);
  return home;
}
