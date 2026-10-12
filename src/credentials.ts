// Where the Webflow login (OAuth client and tokens) is kept: in the macOS Keychain, outside any project folder,
// as Claude Code does with its own MCP logins. Each home folder (paths.ts) has its own item, named by the home's
// path, so a project with its own .wf-mcp/ has its own login.
//
// Items are generic passwords under the service "wf-mcp" (see Keychain Access), written through `security -i`
// on stdin so the tokens never appear in a process list. Values are stored base64-encoded: `security -w` prints
// anything with a line break or other unprintable character as hex, so plain JSON wouldn't read back reliably. The previous login is kept in a second item with
// "#previous" after the path, for `wf-mcp login --force` and a failed re-login to fall back on.
import { HOME } from "./paths.ts";

const SERVICE = "wf-mcp";
export type Slot = "current" | "previous";

export interface CredentialStore {
  // Where the login lives, for messages.
  where: string;
  get(slot?: Slot): string | undefined;
  set(text: string, slot?: Slot): void;
  remove(slot?: Slot): void;
}

function keychain(home: string): CredentialStore {
  const account = (slot: Slot) => (slot === "current" ? home : `${home}#previous`);
  const security = (args: string[], stdin?: string) =>
    Bun.spawnSync(["/usr/bin/security", ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const get = (slot: Slot = "current") => {
    const r = security(["find-generic-password", "-s", SERVICE, "-a", account(slot), "-w"]);
    // 44: no such item.
    if (r.exitCode === 44) return undefined;
    if (r.exitCode !== 0) throw new Error(`Couldn't read the Webflow login from the Keychain: ${r.stderr.toString().trim()}`);
    return Buffer.from(r.stdout.toString().trim(), "base64").toString("utf8");
  };
  return {
    where: `the macOS Keychain (service "${SERVICE}", account "${home}")`,
    get,
    set(text, slot = "current") {
      const name = account(slot);
      if (/["\n\\]/.test(name)) throw new Error(`Can't store a login for a home whose path contains quotes or backslashes: ${home}`);
      const hex = Buffer.from(Buffer.from(text, "utf8").toString("base64"), "utf8").toString("hex");
      security(["-i"], `add-generic-password -U -s ${SERVICE} -a "${name}" -l "wf-mcp Webflow login" -X ${hex}\n`);
      // `security -i` exits 0 even when a command in it fails, so read the item back.
      if (get(slot) !== text) throw new Error("Couldn't save the Webflow login to the Keychain. Is the login keychain locked?");
    },
    remove(slot = "current") {
      security(["delete-generic-password", "-s", SERVICE, "-a", account(slot)]);
    },
  };
}

// The store for this run's home.
export function credentialStore(home = HOME): CredentialStore {
  return keychain(home);
}

// Keep the current login as the previous one and clear the current one. False when there was none.
export function setAside(store: CredentialStore): boolean {
  const current = store.get();
  if (current === undefined) return false;
  store.set(current, "previous");
  store.remove();
  return true;
}

// Put the previous login back, after a new login didn't finish.
export function restorePrevious(store: CredentialStore): void {
  const previous = store.get("previous");
  if (previous !== undefined) store.set(previous);
}

// Delete a home's login, current and previous.
export function forgetLogin(home = HOME): void {
  const store = credentialStore(home);
  for (const slot of ["current", "previous"] as const) store.remove(slot);
}
