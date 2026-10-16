import { expect, test } from "bun:test";
import { actionWords, changeCount, describe as describeCall } from "./confirm.ts";

const items = (n: number) => ({ collection_id: "c1", request: { items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, fieldData: { name: "x".repeat(5000) } })) } });

test("the prompt names the action, the site and how many things the call changes, not the raw input", () => {
  const text = describeCall({
    snippet: "bulk-update.ts",
    name: "data_cms_tool.update_collection_items",
    access: "write",
    site: "abc",
    siteName: "Example Site",
    input: items(12),
  });
  expect(text).toBe(
    [
      "bulk-update.ts wants to update CMS items on Example Site.",
      "",
      "This call updates 12 items.",
      "Allow lets this snippet update CMS items on this site until it finishes.",
    ].join("\n"),
  );
});

test("CMS calls, which name no site, say only what they change", () => {
  const text = describeCall({ snippet: "bulk-update.ts", name: "data_cms_tool.update_collection_items", access: "write", input: items(12) });
  expect(text).toBe(
    [
      "bulk-update.ts wants to update CMS items.",
      "",
      "This call updates 12 items.",
      "Allow lets this snippet update CMS items until it finishes.",
    ].join("\n"),
  );
});

test("the prompt falls back to the site ID, and leaves out the site and count when there are none", () => {
  const base = { snippet: "x.ts", name: "data_pages_tool.update_page_settings", access: "write", input: { page_id: "p" } };
  expect(describeCall({ ...base, site: "abc" })).toContain("wants to update page settings on abc.");
  const text = describeCall(base);
  expect(text).toStartWith("x.ts wants to update page settings.\n");
  expect(text).not.toContain("site");
  expect(text).not.toContain("This call");
});

test("the prompt offers always only when it can be kept", () => {
  const base = { snippet: "x.ts", name: "a.b", access: "write", site: "abc", input: {} };
  expect(describeCall({ ...base, canRemember: true })).toContain("Always allow lets any snippet do it for 7 days.");
  expect(describeCall(base)).not.toContain("Always");
});

test("action names read as a verb and what it changes", () => {
  expect(actionWords("data_cms_tool.update_collection_items")).toMatchObject({ verb: "update", object: "CMS items" });
  expect(actionWords("data_cms_tool.create_collection")).toMatchObject({ verb: "create", object: "CMS collection" });
  expect(actionWords("data_pages_tool.bulk_update_pages")).toMatchObject({ verb: "update", object: "pages" });
  expect(actionWords("data_apps_tool.list_variables")).toMatchObject({ verb: "list", object: "app variables" });
  expect(actionWords("data_scripts_tool.add_site_script")).toMatchObject({ verb: "add", object: "site script" });
  expect(actionWords("element_snapshot_tool")).toMatchObject({ verb: "use", object: "element snapshot" });
  expect(actionWords("data_fonts_tool.batch_delete_fonts")).toMatchObject({ verb: "delete", object: "fonts" });
  expect(actionWords("data_enterprise_tool.replace_robots_txt")).toMatchObject({ object: "robots.txt" });
  expect(actionWords("data_element_settings_tool.set_dom_id")).toMatchObject({ verb: "set", object: "element DOM ID" });
  expect(actionWords("get_more_tools")).toMatchObject({ verb: "send" });
  expect(actionWords("data_campaigns_tool.unlink_delete_personalized_field")).toMatchObject({
    verb: "unlink and delete",
    object: "campaign personalized field",
  });
});

test("the count comes from the array named after the action, and is singular for one", () => {
  expect(changeCount(items(3), "items")).toBe(3);
  expect(changeCount({ site_id: "s", pages: [{ id: "a" }] }, "pages")).toBe(1);
  expect(changeCount({ customDomains: ["a", "b"] }, "site")).toBeUndefined();
  expect(describeCall({ snippet: "x.ts", name: "data_cms_tool.publish_collection_items", access: "destructive", input: items(1) })).toContain(
    "This call publishes 1 item.",
  );
});
