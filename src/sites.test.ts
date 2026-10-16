import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgetSites, parseSites, readSites, refreshSites, saveSites, sitesFromResult } from "./sites.ts";
import { siteLines } from "./snippets.ts";

const site = { id: "site1", displayName: "Example Site" };

test("a list_sites reply gives its sites, and anything else gives none", () => {
  const reply = [{ ...site, extra: 1 }];
  expect(sitesFromResult({ result: { sites: reply } })).toEqual(reply);
  expect(sitesFromResult({ result: { sites: [{ id: 1 }] } })).toBeUndefined();
  expect(sitesFromResult({ result: {} })).toBeUndefined();
  expect(sitesFromResult(null)).toBeUndefined();
});

test("saved sites keep only id and name, read back, and can be forgotten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sites-"));
  const file = path.join(dir, "sites.json");
  expect(readSites(file)).toBeUndefined();
  const withExtra = { ...site, extra: 1 };
  saveSites([withExtra], file);
  expect(readSites(file)?.sites).toEqual([site]);
  forgetSites(file);
  expect(fs.existsSync(file)).toBe(false);
  fs.rmSync(dir, { recursive: true });
});

test("a saved list in the wrong shape is ignored", () => {
  expect(parseSites("not json")).toBeUndefined();
  expect(parseSites(JSON.stringify({ listedAt: "2026-10-16T00:00:00.000Z", sites: [{ id: "x" }] }))).toBeUndefined();
  expect(parseSites(JSON.stringify({ sites: [site] }))).toBeUndefined();
});

test("snippets lists the saved sites, or says how to list them", () => {
  expect(siteLines({ listedAt: "2026-10-16T12:00:00.000Z", sites: [site] }, "list-sites.ts")).toEqual([
    "Sites the login reached on 2026-10-16 (list-sites.ts lists them now):",
    "  site1  Example Site",
  ]);
  expect(siteLines(undefined, "list-sites.ts")).toEqual(["Sites: none saved yet (the login saves them). For site IDs, run list-sites.ts."]);
});

test("a new login's list replaces the old one, and a failed or unreadable reply leaves none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sites-"));
  const file = path.join(dir, "sites.json");
  const other = { id: "site2", displayName: "Other Site" };
  saveSites([site], file);
  expect(await refreshSites(async () => ({ result: { sites: [other] } }), file)).toEqual([other]);
  expect(readSites(file)?.sites).toEqual([other]);
  expect(await refreshSites(async () => ({ error: "no" }), file)).toBeUndefined();
  expect(readSites(file)).toBeUndefined();
  saveSites([site], file);
  await expect(refreshSites(async () => Promise.reject(new Error("offline")), file)).rejects.toThrow("offline");
  expect(readSites(file)).toBeUndefined();
  fs.rmSync(dir, { recursive: true });
});
