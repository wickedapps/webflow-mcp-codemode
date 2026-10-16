import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { APPROVALS_FILE } from "./paths.ts";
import { APPROVAL_DAYS, clearApprovals, isRemembered, listApprovals, remember } from "./trust.ts";

// Leave the real approvals file as it was.
const saved = fs.existsSync(APPROVALS_FILE) ? fs.readFileSync(APPROVALS_FILE, "utf8") : undefined;
beforeEach(() => fs.rmSync(APPROVALS_FILE, { force: true }));
afterAll(() => (saved === undefined ? fs.rmSync(APPROVALS_FILE, { force: true }) : fs.writeFileSync(APPROVALS_FILE, saved)));

test("a kept write covers that action on that site at that level only", () => {
  remember("data_cms_tool.update_collection_items", "site1", "write");
  expect(isRemembered("data_cms_tool.update_collection_items", "site1", "write")).toBe(true);
  expect(isRemembered("data_cms_tool.update_collection_items", "site2", "write")).toBe(false);
  expect(isRemembered("data_cms_tool.update_collection_items", "site1", "destructive")).toBe(false);
  expect(isRemembered("data_cms_tool.create_collection_items", "site1", "write")).toBe(false);
});

test("destructive actions are never kept", () => {
  remember("data_sites_tool.publish_site", "site1", "destructive");
  expect(listApprovals()).toEqual([]);
  expect(isRemembered("data_sites_tool.publish_site", "site1", "destructive")).toBe(false);
});

test("clearing revokes one action or all", () => {
  remember("a.x", undefined, "write");
  remember("b.y", "s", "sensitive");
  expect(clearApprovals("a.x")).toBe(1);
  expect(isRemembered("a.x", undefined, "write")).toBe(false);
  expect(isRemembered("b.y", "s", "sensitive")).toBe(true);
  expect(clearApprovals()).toBe(1);
  expect(listApprovals()).toEqual([]);
});

test("kept approvals expire after APPROVAL_DAYS", () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
  fs.writeFileSync(
    APPROVALS_FILE,
    JSON.stringify([
      { name: "fresh.x", site: "*", access: "write", since: at(APPROVAL_DAYS - 1) },
      { name: "stale.x", site: "*", access: "write", since: at(APPROVAL_DAYS + 0.01) },
      { name: "bad.x", site: "*", access: "write", since: "not a date" },
    ]),
  );
  expect(isRemembered("fresh.x", undefined, "write")).toBe(true);
  expect(isRemembered("stale.x", undefined, "write")).toBe(false);
  expect(isRemembered("bad.x", undefined, "write")).toBe(false);
  expect(listApprovals().map((a) => a.name)).toEqual(["fresh.x"]);
  // Choosing "Always allow" again starts a new period.
  remember("stale.x", undefined, "write");
  expect(isRemembered("stale.x", undefined, "write")).toBe(true);
});

test("a damaged approvals file means asking again, not a failed run", () => {
  fs.writeFileSync(APPROVALS_FILE, "{not json");
  expect(listApprovals()).toEqual([]);
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify({ name: "x" }));
  expect(listApprovals()).toEqual([]);
  const since = new Date().toISOString();
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify([{ name: "a", site: "s", access: "write", since }, { name: "b", site: 1 }]));
  expect(listApprovals().map((a) => a.name)).toEqual(["a"]);
});
