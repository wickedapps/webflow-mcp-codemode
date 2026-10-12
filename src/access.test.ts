import { describe, expect, test } from "bun:test";
import { OVERRIDES, actionAccess, nameAccess, parseAllow } from "./access.ts";
import { buildManifest, readManifest } from "./gen-types.ts";

describe("OVERRIDES", () => {
  test("every entry names a tool or action Webflow still has", () => {
    // Reads the types in the runner's home folder (paths.ts); `bun dev login` or `bun dev gen` writes them.
    const manifest = readManifest();
    expect(manifest).toBeDefined();
    const known = new Set<string>();
    for (const [tool, entry] of Object.entries(manifest!.tools)) {
      if (entry.kind === "call") known.add(tool);
      else for (const action of Object.keys(entry.actions)) known.add(`${tool}.${action}`);
    }
    expect(Object.keys(OVERRIDES).filter((k) => !known.has(k))).toEqual([]);
  });

  test("an override wins over the name", () => {
    expect(actionAccess("data_webhook_tool", "create_webhook")).toEqual({ access: "destructive", guessed: false });
    expect(actionAccess("designer_tool", "switch_page")).toEqual({ access: "read", guessed: false });
    expect(actionAccess("data_cms_tool", "update_collection_items")).toEqual({ access: "write", guessed: true });
  });
});

test("nameAccess", () => {
  expect(nameAccess("list_pages")).toBe("read");
  expect(nameAccess("delete_asset")).toBe("destructive");
  expect(nameAccess("publish_site")).toBe("destructive");
  expect(nameAccess("create_page")).toBe("write");
  expect(nameAccess("getaway")).toBe("write");
});

describe("parseAllow", () => {
  test("reads are always allowed", () => expect([...parseAllow("")]).toEqual(["read"]));
  test("destructive implies write", () => expect(parseAllow("destructive").has("write")).toBe(true));
  test("write does not imply sensitive", () => expect(parseAllow("write").has("sensitive")).toBe(false));
  test("comma list", () => expect([...parseAllow("sensitive, write")].sort()).toEqual(["read", "sensitive", "write"]));
  test("unknown level", () => expect(() => parseAllow("admin")).toThrow(/--allow takes/));
});

test("run-time access levels come from the access table, not a manifest on disk", () => {
  const tool = {
    name: "data_x_tool",
    inputSchema: { type: "object" as const, properties: { actions: { type: "array", items: { anyOf: [
      { type: "object", properties: { delete_thing: { type: "object" } } },
      { type: "object", properties: { list_things: { type: "object" } } },
    ] } } } },
  };
  const entry = buildManifest([tool]).tools.data_x_tool;
  expect(entry.kind === "actions" && entry.actions).toEqual({ delete_thing: "destructive", list_things: "read" });
});
