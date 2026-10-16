import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSandboxed } from "./sandbox.ts";

type Call = { tool: string; action: string | null; input: unknown };
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;

// Runs `code` as a snippet. CMS reads are answered from `items`, sliced by the request's limit and offset; `mutate`
// can change them between calls, as edits made during a run would.
async function run(code: string, items: object[], mutate?: (call: number) => void) {
  const printed: string[] = [];
  const calls: Call[] = [];
  const host = {
    args: [],
    outDir: fs.mkdtempSync(path.join(os.tmpdir(), "wf-sandbox-")),
    async call(tool: string, action: string | null, input: unknown) {
      calls.push({ tool, action, input });
      mutate?.(calls.length);
      const request = field(input, "request");
      const offset = Number(field(request, "offset") ?? 0);
      return { items: items.slice(offset, offset + Number(field(request, "limit") ?? 0)), pagination: { total: items.length, offset } };
    },
    print: (text: string) => printed.push(text),
  };
  const result = await runSandboxed(code, host, new AbortController().signal);
  fs.rmSync(host.outDir, { recursive: true });
  return { result, printed, calls };
}

const item = (n: number, over: object = {}) => ({
  id: `item${n}`,
  isDraft: false,
  isArchived: false,
  lastUpdated: "2026-01-01T00:00:00.000Z",
  lastPublished: "2026-01-01T00:00:01.000Z",
  fieldData: { name: `Item ${n}`, slug: `item-${n}` },
  ...over,
});
const items = (count: number) => Array.from({ length: count }, (_, n) => item(n));

test("cms.listAll reads every page, keeping the request's filter", async () => {
  const { result, printed, calls } = await run(
    `const all = await cms.listAll({ collection_id: "c1", request: { filter: { name: { contains: "Item" } } } });
     console.log(all.length, new Set(all.map((i) => i.id)).size);`,
    items(250),
  );
  expect(result).toBe("ok");
  expect(printed).toEqual(["250 250"]);
  expect(calls.map((c) => c.input)).toEqual(
    [0, 100, 200].map((offset) => ({ collection_id: "c1", request: { filter: { name: { contains: "Item" } }, limit: 100, offset } })),
  );
});

test("cms.listAll throws when items shift while it reads, even if the total doesn't change", async () => {
  const data = items(150);
  // One item added at the front and one removed at the end, after the first page: the second page starts with an
  // item the first page already had.
  const shift = () => {
    data.pop();
    data.unshift(item(999));
  };
  const { result, printed } = await run(`await cms.listAll({ collection_id: "c1" });`, data, (n) => n === 2 && shift());
  expect(result).toBe("error");
  expect(printed.join("\n")).toContain("got 150 entries (149 distinct) of 150");
});

test("cms.listAll throws when the total changes between pages", async () => {
  const data = items(200);
  // Added after the first page: the second page is still full, but reports one more item.
  const { result, printed } = await run(`await cms.listAll({ collection_id: "c1" });`, data, (n) => n === 2 && data.push(item(200)));
  expect(result).toBe("error");
  expect(printed.join("\n")).toContain("had 200 items, then 201");
});

test("cms.listAll rejects limit and offset, and a missing collection_id", async () => {
  for (const code of [`await cms.listAll({ collection_id: "c1", request: { limit: 5 } });`, `await cms.listAll({});`]) {
    const { result, calls } = await run(code, items(3));
    expect(result).toBe("error");
    expect(calls).toEqual([]);
  }
});

test("cms.itemState and cms.isLive read draft, archive and publish dates", async () => {
  const cases = [
    item(0, { isArchived: true, lastPublished: null }),
    item(1, { isDraft: true, lastPublished: null }),
    item(2, { lastPublished: null }),
    item(3),
    // Published, then saved as a draft: still live.
    item(4, { isDraft: true, lastUpdated: "2026-02-01T00:00:00.000Z" }),
    item(5, { lastUpdated: "2026-02-01T00:00:00.000Z" }),
  ];
  const { result, printed } = await run(
    `for (const i of await cms.listAll({ collection_id: "c1" })) console.log(cms.itemState(i), cms.isLive(i));`,
    cases,
  );
  expect(result).toBe("ok");
  expect(printed).toEqual([
    "archived false",
    "draft false",
    "staged false",
    "published true",
    "changes-in-draft true",
    "changes-staged true",
  ]);
});

test("cms.itemState and cms.isLive throw for something that isn't a CMS item, or has bad dates", async () => {
  for (const bad of [{ id: "x", isDraft: false }, item(0, { lastPublished: "" }), item(0, { lastUpdated: "soon" })]) {
    for (const fn of ["itemState", "isLive"]) {
      const { result, printed } = await run(`console.log(cms.${fn}(${JSON.stringify(bad)}));`, []);
      expect(result).toBe("error");
      expect(printed.join("\n")).toContain(`cms.${fn} takes a CMS item`);
    }
  }
});
