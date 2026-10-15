// Entry point of the compiled `wf-mcp` binary.
//   wf-mcp init [dir]               give this project its own home folder (.wf-mcp/), so its own login
//   wf-mcp login [--force]          log in to Webflow in the browser (and generate types/ the first time)
//   wf-mcp logout                   revoke this home's login at Webflow and delete it from the Keychain
//   wf-mcp run <snippet.ts> [...]   run a snippet in the sandbox (see run.ts for its flags)
//   wf-mcp gen                      regenerate types/ from Webflow's tool schemas
//   wf-mcp approvals [--clear [name]]  list, or revoke, the actions the user chose to always allow
//   wf-mcp home                     print the home folder in use: the login, approvals, types/, snippets/ and out/
import { ensureHome } from "./home.ts";
import { HOME, HOME_SOURCE, HOME_TRUSTED } from "./paths.ts";
import { howToRun } from "./plugin.ts";

const VERSION = "1.1.0";
const USAGE = `wf-mcp ${VERSION}: run TypeScript snippets against Webflow's MCP server.

  wf-mcp init [dir]              Give this project its own login: creates .wf-mcp/ at the project root.
  wf-mcp login [--force]         Log in to Webflow in the browser. --force switches workspaces.
  wf-mcp logout                  Revoke this home's Webflow login and delete it.
  wf-mcp run <snippet.ts> [args] Run a snippet. Flags: --allow sensitive,write,destructive, --timeout 90,
                                 --max-output 20000, --concurrency 4, --no-check, --login, --context "..."
  wf-mcp gen                     Regenerate the tool types.
  wf-mcp approvals [--clear [x]] List the write and sensitive actions you chose to always allow, or revoke
                                 them all (or only action x).
  wf-mcp home                    Print the home folder in use (now ${HOME}).

The home folder is $WF_MCP_HOME, else the nearest .wf-mcp/ in this folder or a parent, else ~/.wf-mcp.`;

const [command] = process.argv.splice(2, 1);
// init only creates the project's folder; the next command fills it in.
if (command === "init") {
  const { init } = await import("./init.ts");
  init(process.argv[2]);
  process.exit(0);
}
// A project's .wf-mcp/ that `wf-mcp init` didn't set up for this user could carry someone else's approvals or
// login, so nothing runs from it until it's adopted.
if (!HOME_TRUSTED && !["home", "version", "--version", "help", "--help", "-h", undefined].includes(command)) {
  console.error(
    `[wf-mcp] ${HOME}${HOME_SOURCE === "$WF_MCP_HOME" ? " (named by $WF_MCP_HOME)" : ""} wasn't set up by ` +
      "`wf-mcp init` for you on this machine (it may have come with a repo or a zip, or been moved), so it isn't used. " +
      `To adopt it, ${howToRun("init")} from this project. That deletes any login, approvals and types it came with, keeping ` +
      (HOME_SOURCE === "$WF_MCP_HOME"
        ? "snippets and results. Or unset $WF_MCP_HOME (check the project's .claude/settings.json and any .envrc)."
        : "snippets and results. Or delete the folder to use ~/.wf-mcp."),
  );
  process.exit(5);
}
if (HOME_TRUSTED) ensureHome();
switch (command) {
  case "login": {
    const { login } = await import("./login.ts");
    await login(process.argv.includes("--force"));
    process.exit(0);
  }
  case "logout": {
    const { logout } = await import("./login.ts");
    await logout();
    break;
  }
  case "run":
    // run.ts reads the rest of process.argv and exits when the snippet finishes.
    await import("./run.ts");
    break;
  case "gen": {
    const { generate } = await import("./gen-types.ts");
    await generate();
    process.exit(0);
  }
  case "approvals": {
    const { APPROVAL_DAYS, clearApprovals, expiresAt, listApprovals } = await import("./trust.ts");
    const i = process.argv.indexOf("--clear");
    if (i >= 0) {
      const n = clearApprovals(process.argv[i + 1]);
      console.log(`Revoked ${n} approval${n === 1 ? "" : "s"}. Those actions ask again on their next run.`);
      break;
    }
    const list = listApprovals();
    if (!list.length) console.log("No actions are always allowed. Write and sensitive actions ask once per run.");
    for (const a of list) {
      const site = a.site === "*" ? "any" : a.site;
      console.log(`${a.access.padEnd(9)} ${a.name}  site ${site}  until ${expiresAt(a).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    }
    if (list.length) console.log(`"Always allow" lasts ${APPROVAL_DAYS} days from when it was chosen.`);
    break;
  }
  case "home":
    console.log(HOME);
    if (process.argv.includes("--verbose")) console.error(`(${HOME_SOURCE} home)`);
    if (!HOME_TRUSTED) console.error(`[wf-mcp] Not used until it's adopted, since it wasn't set up by you on this machine. To adopt it, ${howToRun("init")}.`);
    break;
  case "--version":
  case "version":
    console.log(VERSION);
    break;
  default:
    console.error(USAGE);
    process.exit(command && !["help", "--help", "-h"].includes(command) ? 2 : 0);
}
