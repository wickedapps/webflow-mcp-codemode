// Log in to Webflow's MCP server in the browser and show which sites the login reaches.
//   wf-mcp login            log in only if there is no working login
//   wf-mcp login --force    replace the stored login, e.g. to switch workspaces
// Run it in a terminal: runs started by an agent don't open the browser and ask for this instead.
// Also generates types/ the first time, so the first snippet run doesn't have to.
import { callText, connect } from "./client.ts";
import { credentialStore, forgetLogin, setAside, type Slot } from "./credentials.ts";
import { describeRevoke, revokeLogin } from "./revoke.ts";
import { readManifest, schemaHash, writeTypes } from "./gen-types.ts";
import { HOME, HOME_SOURCE, TYPES_DIR } from "./paths.ts";
import { IN_PLUGIN } from "./plugin.ts";

// Printed after a login made in the browser, so a first-time user knows what to expect before it happens.
const NEXT_STEPS = [
  "",
  "What to expect:",
  IN_PLUGIN
    ? '- Ask Claude for something on the site, for example "list the CMS collections".'
    : `- Run a snippet: wf-mcp run ${HOME}/snippets/examples/list-sites.ts`,
  "- Reads run without asking. Creates, updates, deletes, publishes and reads of personal data (form submissions,",
  "  emails, logs) open a macOS dialog first. Deny is the default; nothing is sent until you choose.",
  "- Designer actions and element snapshots need the site open in the Webflow Designer, with the Webflow MCP Bridge",
  "  App running. Everything else works without the Designer.",
].join("\n");

export async function login(force: boolean): Promise<void> {
  const store = credentialStore();
  if (force && setAside(store)) console.error("Kept the old login as the previous one, in case this login doesn't finish.");
  let inBrowser = false;
  const mcp = await connect({ name: "wf-mcp", login: true, store, onLogin: (phase) => {
    if (phase === "start") inBrowser = true;
  } });
  const text = await callText(mcp, "data_sites_tool", { actions: [{ label: "sites", list_sites: {} }] });
  const { result } = JSON.parse(text) as { result?: { sites: Array<{ id: string; displayName: string }> } };
  const scope = HOME_SOURCE === "project" ? "this project" : HOME_SOURCE === "global" ? "every project without its own .wf-mcp/" : "$WF_MCP_HOME";
  console.log(`Logged in for ${HOME} (used by ${scope}). The login is in ${store.where}.`);
  console.log("Sites this login reaches:");
  for (const s of result?.sites ?? []) console.log(`  ${s.id}  ${s.displayName}`);
  // The login --force replaced is no longer needed as a fallback: revoke it, so authorizations don't pile up.
  const previous = force ? store.get("previous") : undefined;
  if (previous !== undefined && previous !== store.get()) {
    try {
      console.log(`The replaced login: ${describeRevoke(await revokeLogin(previous))}.`);
    } catch (err) {
      console.error(`Couldn't revoke the replaced login at Webflow (${(err as Error).message}); remove it in Webflow's workspace settings.`);
    }
    store.remove("previous");
  }
  const { tools } = await mcp.client.listTools();
  if (readManifest()?.hash !== schemaHash(tools)) {
    writeTypes(tools);
    console.log(`Wrote the tool types to ${TYPES_DIR}.`);
  }
  await mcp.client.close();
  if (inBrowser) console.log(NEXT_STEPS);
}

// Revoke this home's login at Webflow, then delete it here, current and previous. The local copy is deleted even
// when Webflow can't be reached.
export async function logout(): Promise<void> {
  const store = credentialStore();
  const results: string[] = [];
  for (const slot of ["current", "previous"] as Slot[]) {
    const text = store.get(slot);
    if (text === undefined) continue;
    try {
      results.push(`${slot === "current" ? "Login" : "Previous login"}: ${describeRevoke(await revokeLogin(text))}.`);
    } catch (err) {
      results.push(`${slot === "current" ? "Login" : "Previous login"}: couldn't reach Webflow to revoke it (${(err as Error).message}); remove the app in Webflow's workspace settings.`);
    }
  }
  forgetLogin();
  if (!results.length) console.log(`No Webflow login was stored for ${HOME}.`);
  else console.log([`Deleted the Webflow login for ${HOME}.`, ...results].join("\n"));
}
