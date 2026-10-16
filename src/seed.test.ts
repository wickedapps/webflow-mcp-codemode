import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import globals from "./seed/globals.d.ts.txt" with { type: "text" };
import { COMPILER_OPTIONS } from "./home.ts";

// The shape gen-types.ts writes for list_collection_items, cut down to what the cms declarations derive from.
const WEBFLOW = `export interface DataCmsTool {
  list_collection_items<T = unknown>(input: {
    collection_id: string;
    request?: {
      cmsLocaleId?: string;
      limit?: number;
      offset?: number;
      filter?: Record<string, { eq?: string; contains?: string; in?: string | Array<string> }>;
      sort?: Record<string, "asc" | "desc">;
    };
  }): Promise<T>;
}
declare global {
  const webflow: { data_cms_tool: DataCmsTool };
}
`;

// Each @ts-expect-error must meet an error, so this also fails if the cms types fall back to any.
const SNIPPET = `export {};
const items = await cms.listAll<{ name: string }>({ collection_id: "c1", request: { filter: { name: { contains: "x" } }, sort: { name: "asc" } } });
for (const i of items) {
  const name: string = i.fieldData.name;
  const state: CmsItemState = cms.itemState(i);
  const live: boolean = cms.isLive(i);
  console.log(name, state, live);
}
// @ts-expect-error collection_id is required
await cms.listAll({ request: {} });
// @ts-expect-error listAll pages itself
await cms.listAll({ collection_id: "c1", request: { limit: 5 } });
// @ts-expect-error listAll pages itself
await cms.listAll({ collection_id: "c1", request: { offset: 5 } });
// @ts-expect-error filters take the generated operators
await cms.listAll({ collection_id: "c1", request: { filter: { name: { like: "x" } } } });
// @ts-expect-error not a state
const bad: CmsItemState = "live";
console.log(bad);
`;

test("snippets typecheck against the cms declarations, which reject bad input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-seed-"));
  const files = { "webflow.ts": WEBFLOW, "globals.d.ts": globals, "snippet.ts": SNIPPET };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: COMPILER_OPTIONS, files: Object.keys(files) }));
  const tsc = path.join(import.meta.dirname, "node_modules/.bin/tsc");
  const check = Bun.spawnSync([tsc, "-p", path.join(dir, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
  fs.rmSync(dir, { recursive: true });
  expect(`${check.stdout.toString()}${check.stderr.toString()}`).toBe("");
  expect(check.exitCode).toBe(0);
});
