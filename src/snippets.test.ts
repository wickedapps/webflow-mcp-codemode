import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { header, snippetFiles } from "./snippets.ts";

test("header is the leading comment lines", () => {
  expect(header("// List items by status.\n//   wf-mcp run x.ts <siteId>\nexport {};\n// later")).toEqual([
    "List items by status.",
    "  wf-mcp run x.ts <siteId>",
  ]);
  expect(header("export {};")).toEqual([]);
});

test("snippetFiles skips the listed folders, declarations and dot folders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-snippets-"));
  for (const f of ["a.ts", "cms/b.ts", "examples/c.ts", "scratch/d.ts", ".hidden/e.ts", "globals.d.ts", "notes.md"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "");
  }
  expect(snippetFiles(dir, ["examples", "scratch"])).toEqual(["a.ts", "cms/b.ts"]);
});
