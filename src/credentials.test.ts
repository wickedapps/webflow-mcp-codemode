import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialStore, forgetLogin, restorePrevious, setAside } from "./credentials.ts";

// Uses real Keychain items under a throwaway home path, deleted at the end.
test("a login round-trips through the Keychain, and forgetLogin deletes it", () => {
  const home = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-mcp-cred-"))), "a b", ".wf-mcp");
  fs.mkdirSync(home, { recursive: true });
  // Line breaks and quotes: `security -w` would print these as hex without the base64 encoding.
  const login = '{\n  "tokens": {"access_token": "x y \\"z\\""}\n}';
  try {
    const store = credentialStore(home);
    store.set(login);
    store.set('{"old":true}', "previous");
    expect(store.get()).toBe(login);
    expect(store.get("previous")).toBe('{"old":true}');

    expect(setAside(store)).toBe(true);
    expect(store.get()).toBeUndefined();
    expect(store.get("previous")).toBe(login);
    restorePrevious(store);
    expect(store.get()).toBe(login);

    forgetLogin(home);
    expect(store.get()).toBeUndefined();
    expect(store.get("previous")).toBeUndefined();
  } finally {
    forgetLogin(home);
    fs.rmSync(path.dirname(path.dirname(home)), { recursive: true, force: true });
  }
});
