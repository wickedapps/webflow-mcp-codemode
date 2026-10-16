// List the snippets in the home folder with their header comments, so a session can find one to reuse before
// writing a new one.
//   wf-mcp snippets
// First the sites the login reached when it logged in (sites.ts), for their IDs. Then the saved snippets: anything
// in snippets/ outside examples/ and scratch/, written by the user or an earlier session. Then the plugin's examples. scratch/ holds one-off snippets and isn't listed.
import fs from "node:fs";
import path from "node:path";
import { EXAMPLES_DIR, SNIPPETS_DIR } from "./paths.ts";
import { readSites, type SiteList } from "./sites.ts";

export const SCRATCH = "scratch";
const HEADER_LINES = 8;

// A snippet's leading `//` comment lines, without the slashes.
export function header(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("//")) break;
    lines.push(line.replace(/^\/\/ ?/, ""));
    if (lines.length === HEADER_LINES) break;
  }
  return lines;
}

// Snippet files under `dir`, as paths relative to it, skipping the folders in `skip` (relative to `dir`).
export function snippetFiles(dir: string, skip: string[] = []): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        if (!skip.includes(child)) walk(child);
      } else if (/\.(ts|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(child);
    }
  };
  walk("");
  return out.sort();
}

function section(title: string, dir: string, files: string[], empty: string): string[] {
  const lines = [title];
  if (!files.length) lines.push(`  ${empty}`);
  for (const file of files) {
    const about = header(fs.readFileSync(path.join(dir, file), "utf8"));
    lines.push(`  ${file}`, ...(about.length ? about.map((l) => `    ${l}`) : ["    (no header comment)"]));
  }
  return lines;
}

export function siteLines(list: SiteList | undefined, listSites: string): string[] {
  if (!list) return [`Sites: none saved yet (the login saves them). For site IDs, run ${listSites}.`];
  return [
    `Sites the login reached on ${list.listedAt.slice(0, 10)} (${listSites} lists them now):`,
    ...(list.sites.length ? list.sites.map((s) => `  ${s.id}  ${s.displayName}`) : ["  none"]),
  ];
}

export function printSnippets(): void {
  const saved = snippetFiles(SNIPPETS_DIR, [path.relative(SNIPPETS_DIR, EXAMPLES_DIR), SCRATCH]);
  const examples = snippetFiles(EXAMPLES_DIR);
  console.log(
    [
      ...siteLines(readSites(), path.join(EXAMPLES_DIR, "list-sites.ts")),
      "",
      ...section(`Saved snippets in ${SNIPPETS_DIR}/:`, SNIPPETS_DIR, saved, "none yet"),
      "",
      ...section(`Examples in ${EXAMPLES_DIR}/ (from the plugin, rewritten on each update; copy one before changing it):`, EXAMPLES_DIR, examples, "none"),
    ].join("\n"),
  );
}
