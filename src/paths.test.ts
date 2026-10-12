import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProjectHome, projectHomeTrusted, signProjectHome } from "./paths.ts";

test("the nearest .wf-mcp folder in the directory or a parent is the home", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-mcp-paths-")));
  const deep = path.join(root, "project", "src", "deep");
  fs.mkdirSync(deep, { recursive: true });
  expect(findProjectHome(deep)).toBeUndefined();
  fs.mkdirSync(path.join(root, "project", ".wf-mcp"));
  expect(findProjectHome(deep)).toBe(path.join(root, "project", ".wf-mcp"));
  fs.mkdirSync(path.join(root, "project", "src", ".wf-mcp"));
  expect(findProjectHome(deep)).toBe(path.join(root, "project", "src", ".wf-mcp"));
  // A file named .wf-mcp isn't a home.
  fs.writeFileSync(path.join(deep, ".wf-mcp"), "");
  expect(findProjectHome(deep)).toBe(path.join(root, "project", "src", ".wf-mcp"));
  fs.rmSync(root, { recursive: true });
});

test("only a project home signed for this user is trusted, and only where it was signed", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-mcp-sign-")));
  const home = path.join(root, "a", ".wf-mcp");
  fs.mkdirSync(home, { recursive: true });
  expect(projectHomeTrusted(home)).toBe(false);
  signProjectHome(home);
  expect(projectHomeTrusted(home)).toBe(true);
  // A forged marker isn't trusted.
  const forged = path.join(root, "b", ".wf-mcp");
  fs.mkdirSync(forged, { recursive: true });
  fs.writeFileSync(path.join(forged, ".owner"), "00".repeat(32));
  expect(projectHomeTrusted(forged)).toBe(false);
  // Nor is a signed folder copied elsewhere, marker and all.
  const copy = path.join(root, "c", ".wf-mcp");
  fs.cpSync(home, copy, { recursive: true });
  expect(projectHomeTrusted(copy)).toBe(false);
  fs.rmSync(root, { recursive: true });
});
