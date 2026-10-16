import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNS, loadShapes, merge, render, saveShapes, shapeNote, shapeOf } from "./shapes.ts";

const shapeOfAll = (...values: unknown[]) => values.map((v) => shapeOf(v)).reduce((a, b) => merge(a, b));

test("records key names and types, never values", () => {
  const shape = shapeOf({ references: [{ resourceId: "123", resource: { type: "site", displayName: "Example Site" } }] });
  const text = render(shape);
  expect(text).toBe("{ references: Array<{ resourceId: string; resource: { type: string; displayName: string } }> }");
  expect(JSON.stringify(shape)).not.toContain("Example Site");
});

test("a key some objects lack is optional, and a value's forms are a union", () => {
  const shape = shapeOf({
    variations: [
      { name: "A", comparison: { isBaseline: true, lift: 0 } },
      { name: "B", comparison: { isBaseline: false, lift: 0.1, note: null }, extra: "x" },
    ],
  });
  expect(render(shape)).toBe(
    [
      "{",
      "  variations: Array<{",
      "    name: string;",
      "    comparison: { isBaseline: boolean; lift: number; note?: null };",
      "    extra?: string;",
      "  }>;",
      "}",
    ].join("\n"),
  );
});

test("merging calls keeps keys seen in only some of them optional", () => {
  const shape = shapeOfAll({ items: [], nextCursor: "abc" }, { items: [{ id: "1" }] }, { items: [], nextCursor: null });
  expect(render(shape)).toBe("{ items: Array<{ id: string }>; nextCursor?: null | string }");
  expect(render(shapeOf({ items: [] }))).toBe("{ items: unknown[] /* only empty arrays seen */ }");
});

test("objects keyed by IDs or data are maps, and keep none of their keys", () => {
  const shape = shapeOf({ byId: { "5f0c8a1b2c3d4e5f6a7b8c9d": { n: 1 }, "123": { n: 2, label: "x" } } });
  expect(render(shape)).toBe("{ byId: Record<string, { n: number; label?: string }> }");
  const byEmail = shapeOf({ people: { "someone@example.com": 1, total: 2 }, pages: { "/blog/post": 3 } });
  expect(render(byEmail)).toBe("{ people: Record<string, number>; pages: Record<string, number> }");
  expect(JSON.stringify(byEmail)).not.toContain("example.com");
});

test("fieldData is a map, so different collections don't mix their fields", () => {
  const a = shapeOf({ items: [{ id: "1", fieldData: { name: "x", "price-id": "y" } }] });
  const b = shapeOf({ items: [{ id: "2", fieldData: { name: "x", "event-date": "z" } }] });
  expect(render(merge(a, b))).toBe("{ items: Array<{ id: string; fieldData: Record<string, string> }> }");
});

test("an empty object where maps are seen is an empty map", () => {
  expect(render(merge(shapeOf({ byId: {} }), shapeOf({ byId: { "123": 1 } })))).toBe("{ byId: Record<string, number> }");
});

test("keys like constructor and __proto__ are plain keys", () => {
  const shape = merge(shapeOf({ a: 1 }), shapeOf(JSON.parse('{ "constructor": "x", "__proto__": 2 }')));
  expect(render(shape)).toBe("{ a?: number; constructor?: string; __proto__?: number }");
});

test("long key names are kept whole", () => {
  const key = "k".repeat(60);
  expect(render(shapeOf({ [key]: 1 }))).toContain(key);
});

test("long types break over lines, and odd keys are quoted", () => {
  const item = { id: "1", isDraft: false, meta: { name: "a", slug: "b", "price-id": "c", "a-long-field-name": 1 } };
  const text = render(shapeOf({ items: [item], pagination: { total: 1, offset: 0, limit: 100 } }), { indent: "  " });
  expect(text).toBe(
    [
      "{",
      "    items: Array<{",
      "      id: string;",
      "      isDraft: boolean;",
      '      meta: { name: string; slug: string; "price-id": string; "a-long-field-name": number };',
      "    }>;",
      "    pagination: { total: number; offset: number; limit: number };",
      "  }",
    ].join("\n"),
  );
});

test("more than 40 keys are counted, not listed", () => {
  const meta = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`field${i}`, i]));
  const text = render(shapeOf({ meta }));
  expect(text).toContain("field39: number;");
  expect(text).not.toContain("field40");
  expect(text).toContain("/* 5 more keys */");
});

test("depth is bounded", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 20; i++) deep = { next: deep };
  expect(render(shapeOf(deep))).toContain("unknown");
});

test("a long note shows fewer levels and stays valid TypeScript", () => {
  const group = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`prop${i}`, { inner: { value: i } }]));
  const value = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`group${i}`, group]));
  const note = shapeNote("tool.big", new Map([["tool.big", { runs: [{ day: "2026-01-01", shape: shapeOf(value) }] }]])) ?? "";
  expect(note.length).toBeGreaterThan(0);
  expect(note.length).toBeLessThan(8000);
  expect(note).toContain("shown as unknown");
  // Bun's transpiler rejects a type that was cut off mid-way.
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(note)).not.toThrow();
});

test("saveShapes keeps each action's last runs and reports actions new to the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mcp-shapes-"));
  const file = path.join(dir, "shapes.json");
  try {
    expect(saveShapes(new Map([["tool.read_a", shapeOf({ gone: 1 })]]), { file, today: "2026-01-01" })).toEqual(["tool.read_a"]);
    const added = saveShapes(
      new Map([
        ["tool.read_a", shapeOf({ a: 2, b: "x" })],
        ["tool.read_b", shapeOf([])],
      ]),
      { file, today: "2026-01-02" },
    );
    expect(added).toEqual(["tool.read_b"]);
    expect(shapeNote("tool.read_a", loadShapes(file))).toContain("type Result = { a?: number; b?: string; gone?: number };");
    expect(shapeNote("tool.read_a", loadShapes(file))).toContain("the last 2 runs (2026-01-01 to 2026-01-02)");
    // After RUNS more runs, the first one's keys have dropped out.
    for (let i = 0; i < RUNS; i++) saveShapes(new Map([["tool.read_a", shapeOf({ a: 2 })]]), { file, today: "2026-01-03" });
    expect(shapeNote("tool.read_a", loadShapes(file))).toContain("type Result = { a: number };");
    expect(shapeNote("tool.missing", loadShapes(file))).toBeUndefined();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveShapes waits for another run's lock, and never takes one over", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mcp-shapes-"));
  const file = path.join(dir, "shapes.json");
  try {
    fs.mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(() => saveShapes(new Map([["tool.a", shapeOf(1)]]), { file })).toThrow("Delete it if no wf-mcp run is going");
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    fs.rmSync(`${file}.lock`, { recursive: true });
    expect(saveShapes(new Map([["tool.a", shapeOf(1)]]), { file })).toEqual(["tool.a"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing, broken or malformed file reads as empty, dropping only bad entries", () => {
  expect(loadShapes("/nonexistent/shapes.json").size).toBe(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mcp-shapes-"));
  const file = path.join(dir, "shapes.json");
  try {
    fs.writeFileSync(file, "not json");
    expect(loadShapes(file).size).toBe(0);
    const good = { runs: [{ day: "2026-01-01", shape: shapeOf({ a: 1 }) }] };
    fs.writeFileSync(
      file,
      JSON.stringify({
        "tool.good": good,
        "tool.no_keys": { runs: [{ day: "2026-01-01", shape: { object: { n: 1 } } }] },
        "tool.bad_prim": { runs: [{ day: "2026-01-01", shape: { prims: ["date"] } }] },
        "tool.old_format": { first: "2026-01-01", last: "2026-01-01", shape: {} },
      }),
    );
    expect([...loadShapes(file).keys()]).toEqual(["tool.good"]);
    expect(shapeNote("tool.no_keys", loadShapes(file))).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
