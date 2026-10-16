import { expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TYPES_FORMAT, buildManifest, narrowing, objectTs, schemaHash, staleTypes } from "./gen-types.ts";

test("narrowing finds filter and sort inputs, nested or not", () => {
  expect(narrowing({ properties: { collection_id: {}, request: { properties: { filter: {}, sortBy: {}, limit: {} } } } })).toEqual(["filter", "sort"]);
  expect(narrowing({ properties: { site_id: {}, filter: {} } })).toEqual(["filter"]);
  expect(narrowing({ properties: { site_id: {}, limit: {} } })).toEqual([]);
  expect(narrowing(undefined)).toEqual([]);
});

const tools: Tool[] = [{ name: "data_x_tool", inputSchema: { type: "object", properties: {} } }];

test("types are stale when the schemas change, or only the format", () => {
  const current = { ...buildManifest(tools), format: TYPES_FORMAT };
  expect(staleTypes(current, tools)).toBeUndefined();
  expect(staleTypes(undefined, tools)).toBe("schemas");
  expect(staleTypes({ ...current, hash: "old" }, tools)).toBe("schemas");
  const { format: _format, ...older } = current;
  expect(staleTypes(older, tools)).toBe("format");
  expect(current.hash).toBe(schemaHash(tools));
});

test("deprecated inputs are left out of the types unless required", () => {
  const ts = objectTs(
    {
      properties: {
        items: { type: "array", items: { type: "string" } },
        itemIds: { type: "array", items: { type: "string" }, description: "Deprecated earlier shape: use items instead." },
        isDraft: { type: "boolean", description: "Deprecated: use items[].isDraft instead." },
        legacy: { type: "string", description: "deprecated, but still required" },
        note: { type: "string", description: "Not deprecated, just mentions the word." },
      },
      required: ["legacy"],
    },
    "",
  );
  expect(ts).toContain("items?:");
  expect(ts).toContain("legacy:");
  expect(ts).toContain("note?:");
  expect(ts).not.toContain("itemIds");
  expect(ts).not.toContain("isDraft");
  expect(objectTs({ properties: { old: { type: "string", description: "Deprecated." } } }, "")).toBe("Record<string, never>");
});
