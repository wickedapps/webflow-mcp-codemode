// Set up the runner's home folder (paths.ts) on first use: the files snippets are typechecked with, and the
// example snippets. They're embedded in the binary, so the support files are rewritten on every run to match
// it, while snippets are only added when missing, so a user's edits survive.
import fs from "node:fs";
import path from "node:path";
import globals from "./seed/globals.d.ts.txt" with { type: "text" };
import findText from "./seed/find-text.ts.txt" with { type: "text" };
import getStyle from "./seed/get-style.ts.txt" with { type: "text" };
import listCollections from "./seed/list-collections.ts.txt" with { type: "text" };
import listPages from "./seed/list-pages.ts.txt" with { type: "text" };
import listSites from "./seed/list-sites.ts.txt" with { type: "text" };
import smokeTest from "./seed/smoke-test.ts.txt" with { type: "text" };
import snapshot from "./seed/snapshot.ts.txt" with { type: "text" };
import { HOME, OUT_DIR, SNIPPETS_DIR, SUPPORT_DIR, TYPES_DIR } from "./paths.ts";

// Snippets are checked with the ES2023 library and the sandbox's globals only, so Node and Bun APIs fail.
const COMPILER_OPTIONS = {
  target: "ES2023",
  lib: ["ES2023"],
  module: "esnext",
  moduleResolution: "bundler",
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  erasableSyntaxOnly: true,
  skipLibCheck: true,
  types: [],
};

const SNIPPETS: Record<string, string> = {
  "find-text.ts": findText,
  "get-style.ts": getStyle,
  "list-collections.ts": listCollections,
  "list-pages.ts": listPages,
  "list-sites.ts": listSites,
  "smoke-test.ts": smokeTest,
  "snapshot.ts": snapshot,
};

const writeIfChanged = (file: string, text: string) => {
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
};

export function ensureHome(): void {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  for (const dir of [SUPPORT_DIR, SNIPPETS_DIR, OUT_DIR]) fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(path.join(SUPPORT_DIR, "globals.d.ts"), globals);
  writeIfChanged(path.join(SUPPORT_DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: COMPILER_OPTIONS }, null, 2) + "\n");
  // Lets an editor typecheck the snippets folder the way the runner does.
  writeIfChanged(
    path.join(SNIPPETS_DIR, "tsconfig.json"),
    JSON.stringify(
      {
        extends: path.join(SUPPORT_DIR, "tsconfig.json"),
        include: ["*.ts", "**/*.ts", path.join(TYPES_DIR, "webflow.ts"), path.join(SUPPORT_DIR, "globals.d.ts")],
      },
      null,
      2,
    ) + "\n",
  );
  for (const [name, text] of Object.entries(SNIPPETS)) {
    const file = path.join(SNIPPETS_DIR, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
  }
}
