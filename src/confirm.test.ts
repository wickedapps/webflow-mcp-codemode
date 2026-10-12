import { expect, test } from "bun:test";
import { describe as describeCall } from "./confirm.ts";

test("the prompt names the call, the site and a shortened input", () => {
  const text = describeCall({ snippet: "x.ts", name: "data_cms_tool.update_collection_items", access: "write", site: "abc", input: { s: "y".repeat(1000) } });
  expect(text).toContain("x.ts wants to make a write call");
  expect(text).toContain("data_cms_tool.update_collection_items");
  expect(text).toContain("Site: abc");
  expect(text).toMatch(/… \(\d+ characters\)/);
  expect(text.length).toBeLessThan(800);
});

test("the prompt offers always only when it can be kept", () => {
  const base = { snippet: "x.ts", name: "a.b", access: "write", site: "abc", input: {} };
  expect(describeCall({ ...base, canRemember: true })).toContain("or always on this site");
  expect(describeCall(base)).not.toContain("always");
});
