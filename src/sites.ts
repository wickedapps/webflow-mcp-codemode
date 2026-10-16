// The sites the login reached, saved by `wf-mcp login` and printed by `wf-mcp snippets`, so a session can pick a
// site ID without a run or a search through old files. It's only a record of the last login; the snippet
// examples/list-sites.ts lists them live.
import fs from "node:fs";
import { SITES_FILE } from "./paths.ts";

export type Site = { id: string; displayName: string };
export type SiteList = { listedAt: string; sites: Site[] };

export function saveSites(sites: Site[], file = SITES_FILE): void {
  const list: SiteList = { listedAt: new Date().toISOString(), sites: sites.map(({ id, displayName }) => ({ id, displayName })) };
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
}

const isSite = (v: unknown): v is Site =>
  typeof v === "object" && v !== null && "id" in v && typeof v.id === "string" && "displayName" in v && typeof v.displayName === "string";

// The sites in a list_sites reply ({ result: { sites } }), or undefined when it isn't that shape.
export function sitesFromResult(value: unknown): Site[] | undefined {
  if (typeof value !== "object" || value === null || !("result" in value)) return undefined;
  const { result } = value;
  if (typeof result !== "object" || result === null || !("sites" in result)) return undefined;
  const { sites } = result;
  return Array.isArray(sites) && sites.every(isSite) ? sites : undefined;
}

// The saved list, or undefined when there's none or it isn't in the expected shape.
export function parseSites(text: string): SiteList | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("listedAt" in value) || !("sites" in value)) return undefined;
  const { listedAt, sites } = value;
  if (typeof listedAt !== "string" || !Array.isArray(sites) || !sites.every(isSite)) return undefined;
  return { listedAt, sites };
}

// Replaces the saved list with the sites in what `list` returns (a list_sites reply). The old list goes first, so
// a failed call or an unreadable reply leaves no list rather than one from an earlier login.
export async function refreshSites(list: () => Promise<unknown>, file = SITES_FILE): Promise<Site[] | undefined> {
  forgetSites(file);
  const sites = sitesFromResult(await list());
  if (sites) saveSites(sites, file);
  return sites;
}

export function readSites(file = SITES_FILE): SiteList | undefined {
  return fs.existsSync(file) ? parseSites(fs.readFileSync(file, "utf8")) : undefined;
}

export function forgetSites(file = SITES_FILE): void {
  fs.rmSync(file, { force: true });
}
