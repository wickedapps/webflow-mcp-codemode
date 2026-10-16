// Approvals the user chose to keep ("Always allow"), so a write or sensitive action on a site isn't asked about
// on every run. They expire after APPROVAL_DAYS; choosing "Always allow" again starts a new period. Destructive
// actions are never kept: they're asked about once per run, every run.
// Stored in approvals.json in the runner's home folder; `wf-mcp approvals` lists them and `--clear` revokes them.
import fs from "node:fs";
import type { Access } from "./access.ts";
import { APPROVALS_FILE } from "./paths.ts";

export interface Approval {
  name: string;
  // "*" when the call names no site.
  site: string;
  access: Access;
  since: string;
}

export const APPROVAL_DAYS = 7;
const APPROVAL_MS = APPROVAL_DAYS * 24 * 60 * 60 * 1000;

export const expiresAt = (a: Approval) => new Date(Date.parse(a.since) + APPROVAL_MS);
// An unreadable date counts as expired.
const current = (a: Approval, now = Date.now()) => Date.parse(a.since) + APPROVAL_MS > now;

export const rememberable = (access: Access) => access === "write" || access === "sensitive";

const isApproval = (v: unknown): v is Approval =>
  !!v &&
  typeof v === "object" &&
  ["name", "site", "access", "since"].every((k) => typeof (v as Record<string, unknown>)[k] === "string");

// Expired and malformed approvals are dropped as they're read, and from the file the next time it's written, so a
// damaged file means being asked again rather than a failed run.
function load(): Approval[] {
  if (!fs.existsSync(APPROVALS_FILE)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(APPROVALS_FILE, "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isApproval).filter((a) => current(a)) : [];
}
const save = (list: Approval[]) => fs.writeFileSync(APPROVALS_FILE, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });

// Kept approvals only cover the access level they were given at: if an action's level goes up in a later
// release, it's asked about again.
export function isRemembered(name: string, site: string | undefined, access: Access): boolean {
  if (!rememberable(access)) return false;
  return load().some((a) => a.name === name && a.site === (site ?? "*") && a.access === access);
}

export function remember(name: string, site: string | undefined, access: Access): void {
  if (!rememberable(access)) return;
  const list = load().filter((a) => !(a.name === name && a.site === (site ?? "*")));
  save([...list, { name, site: site ?? "*", access, since: new Date().toISOString() }]);
}

export function listApprovals(): Approval[] {
  return load();
}

// Revokes every kept approval, or only those matching `name` (an action like data_cms_tool.update_collection_items).
export function clearApprovals(name?: string): number {
  const list = load();
  const keep = name ? list.filter((a) => a.name !== name) : [];
  save(keep);
  return list.length - keep.length;
}
