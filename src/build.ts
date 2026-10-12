// Build the plugin: the Apple silicon `wf-mcp` binary with the native TypeScript compiler beside it, written to
// ../plugins/webflow-codemode/scripts/, then the plugin zipped to ../plugins/webflow-codemode.zip for upload, and the
// zip's release URL and hash written into ../.claude-plugin/marketplace.json.
//   bun build.ts
// Bun's own signature on a compiled binary doesn't survive macOS's check, so it's signed again ad hoc.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PLUGINS = path.resolve(import.meta.dirname, "../plugins");
const PLUGIN = path.join(PLUGINS, "webflow-codemode");
const SCRIPTS = path.join(PLUGIN, "scripts");
const ZIP = path.join(PLUGINS, "webflow-codemode.zip");
const MARKETPLACE = path.resolve(import.meta.dirname, "../.claude-plugin/marketplace.json");
const ARCH = "arm64";
const tsVersion = (JSON.parse(fs.readFileSync("node_modules/typescript/package.json", "utf8")) as { version: string }).version;
const version = (JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin/plugin.json"), "utf8")) as { version: string }).version;

const run = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`Failed: ${cmd.join(" ")}`);
};

// Building on another Mac, the arm64 compiler isn't installed, so it's fetched from npm at the locked version.
function typescriptLib(arch: string): string {
  const pkg = `@typescript/typescript-darwin-${arch}`;
  const local = path.join("node_modules", pkg, "lib");
  if (fs.existsSync(local)) return local;
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "wf-mcp-ts-"));
  run(["npm", "pack", `${pkg}@${tsVersion}`, "--silent"], tmp);
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack ${pkg} produced no tarball`);
  run(["tar", "-xzf", tgz], tmp);
  return path.join(tmp, "package", "lib");
}

// Installed copies are cached by plugin.json's version, and `wf-mcp --version` should report the same one.
if (!fs.readFileSync("cli.ts", "utf8").includes(`const VERSION = "${version}";`)) {
  throw new Error(`VERSION in cli.ts doesn't match plugin.json (${version}).`);
}
run(["bun", "run", "typecheck"]);
// Clear everything a build writes, including the launcher's .checked.
for (const name of fs.readdirSync(SCRIPTS)) {
  if (name !== "wf-mcp") fs.rmSync(path.join(SCRIPTS, name), { recursive: true, force: true });
}
const bin = path.join(SCRIPTS, `wf-mcp-darwin-${ARCH}`);
run(["bun", "build", "cli.ts", "--compile", `--target=bun-darwin-${ARCH}`, "--outfile", bin]);
run(["codesign", "--force", "--sign", "-", bin]);
const ts = path.join(SCRIPTS, `typescript-darwin-${ARCH}`);
fs.cpSync(typescriptLib(ARCH), ts, { recursive: true });
// npm installs the compiler writable by everyone; a plugin binary shouldn't be.
fs.chmodSync(path.join(ts, "tsc"), 0o755);
console.log(`Built ${path.relative(process.cwd(), bin)} with TypeScript ${tsVersion}.`);

// zip keeps the executable bits; -X leaves out macOS metadata, so the zip has no __MACOSX/ or ._ files.
fs.rmSync(ZIP, { force: true });
run(["zip", "-r", "-X", "-q", ZIP, "webflow-codemode", "-x", "*.DS_Store"], PLUGINS);
console.log(`Zipped version ${version} to ${path.relative(process.cwd(), ZIP)}.`);

// Users install the zip attached to the v<version> GitHub release, so the marketplace entry points there, pinned by
// the zip's hash. Upload this exact zip: a rebuilt one has a different hash, and Claude Code refuses it.
const marketplace = JSON.parse(fs.readFileSync(MARKETPLACE, "utf8")) as {
  plugins: { name: string; source: unknown; repository: string }[];
};
const entry = marketplace.plugins.find((p) => p.name === "webflow-codemode");
if (!entry) throw new Error(`No webflow-codemode entry in ${MARKETPLACE}.`);
const sha256 = createHash("sha256").update(fs.readFileSync(ZIP)).digest("hex");
const url = `${entry.repository}/releases/download/v${version}/webflow-codemode.zip`;
entry.source = { source: "archive", url, sha256 };
fs.writeFileSync(MARKETPLACE, `${JSON.stringify(marketplace, null, 2)}\n`);
console.log(`Pointed the marketplace entry at ${url} (sha256 ${sha256}).`);
