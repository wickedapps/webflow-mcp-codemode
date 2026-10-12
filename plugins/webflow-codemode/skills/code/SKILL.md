---
name: code
description: Read or change Webflow site data (CMS collections and items, pages, styles, components, assets, forms, Designer elements) by writing a short TypeScript snippet and running it in a sandbox, instead of calling Webflow MCP tools one at a time. Use for bulk reads, exports, audits, finding text across a site, loops and joins across collections, and batched CMS edits.
argument-hint: "<task>"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp run *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp home *) Read(~/.wf-mcp/**) Edit(~/.wf-mcp/snippets/**) Edit(./.wf-mcp/snippets/**)
---

# Webflow MCP from code

The runner is `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp` (called `wf-mcp` below; always use the full path). Run it from the project's directory. Run each `wf-mcp` command as its own Bash call, written out in full: no shell variables, `;`, `&&`, pipes, `echo` or `$?`. Only a plain command matches the ones this skill pre-approves; anything else makes the user approve it. A failing command's exit code is reported anyway.

Its **home folder** holds the always-allowed approvals, the generated types in `types/`, snippets in `snippets/` and results in `out/`. Each home has its own Webflow login, kept in the macOS Keychain (service `wf-mcp`, account = the home's path), not in the folder. The home is the first of:
1. `$WF_MCP_HOME`, if set;
2. the nearest `.wf-mcp/` folder in the working directory or a parent of it: a project with its own login. It's only used if `wf-mcp init` set it up for this user on this machine; otherwise every command exits with code 5 (see below);
3. `~/.wf-mcp`, shared by every project without its own.

Run `wf-mcp home` once at the start and use the folder it prints wherever `<home>` appears below.

## First use

If a run exits with code 3, the user needs to log in. Do it as below, or suggest they type `/webflow-codemode:login` (`/webflow-codemode:login project` for a project-only login):

1. If a command exits with code 5, the project has a `.wf-mcp/` folder that wasn't set up by this user on this machine: it may have come with a repo or a zip. Tell the user, and only with their go-ahead run `wf-mcp init` to adopt it (it deletes the login, approvals and types inside) or have them delete the folder. Don't adopt it on your own.
2. If the user wants this project to have its own Webflow login (for example, a different client or workspace than their other projects), run `wf-mcp init` first. It creates `.wf-mcp/` at the project root (the git root if there is one), which ignores itself in git. Otherwise the login goes to the shared `~/.wf-mcp`. If it isn't clear which they want, ask.
3. Tell them a browser tab will open on Webflow's consent page, where they pick the workspace and sites to authorize.
4. Run `wf-mcp login` with a Bash timeout of 6 minutes. It waits up to 5 minutes for the browser, then saves the login to the Keychain, lists the sites it reaches and writes `<home>/types/`. Pass on the "What to expect" notes it prints after a new login.
5. One login covers one Webflow workspace. `wf-mcp login --force` replaces the login for the current home, for example to switch workspaces. Logging out is the user's call: point them to `/webflow-codemode:logout` rather than running `wf-mcp logout` yourself. Never read the Keychain item yourself (for example with `security find-generic-password`).

## Writing and running a snippet

1. Read `<home>/types/index.md` to find the tool and action. Open only the `<home>/types/<tool>.ts` files you need for exact inputs.
2. Write the snippet in `<home>/snippets/` (or a subfolder). It's a module (`export {};` if it has no imports) that runs in a QuickJS sandbox, not Node or Bun. Its globals are `webflow`, `console`, `args` (its arguments), `out` (`out.write(name, data)` and `out.read(name)` for files in `<home>/out/`) and `sleep(ms)`; see `<home>/support/globals.d.ts`. It can import `.ts` files from its own folder, but no packages or `node:` modules, and it has no `fetch`.
   - `await webflow.data_cms_tool.list_collection_items({ collection_id, request: { limit: 100 } })` calls one action and returns its result, or throws the action's error.
   - Tools with tool-level args take them second: `webflow.data_style_tool.query_styles(input, { siteId, pageId })`.
   - Tools without actions are called directly: `webflow.webflow_guide_tool()`.
   - Results are `unknown` unless you pass a type: `list_sites<{ sites: Site[] }>()`.
   - `designer_tool` actions resolve to their `data` (e.g. `get_current_page(true, { siteId })` gives `{ id, pageName, ... }`).
   - Calls that return images (`element_snapshot_tool`) resolve to `{ images, result }`: `images` are PNG paths in `<home>/out/`. Read them to see the snapshot. `snippets/snapshot.ts <siteId>` is an example.
   - Existing examples in `<home>/snippets/`: `list-sites.ts`, `list-pages.ts <siteId>`, `list-collections.ts <siteId>`, `find-text.ts` (a phrase anywhere in a site), `get-style.ts`, `snapshot.ts`, `smoke-test.ts`.
3. `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp run <home>/snippets/<file>.ts [args...]`. Extra arguments reach the snippet as `args`. The runner typechecks the snippet first and exits with code 2 on type errors; fix them rather than passing `--no-check`.
   - Read calls only by default. `--allow sensitive` permits reads of personal data and secrets (form submissions, emails, env variables, logs), `--allow write` creates and updates, `--allow destructive` deletes, publishes and site-wide changes; combine them with commas. Ask the user before using any of them. `types/index.md` shows each action's level.
   - The first call of each sensitive, write or destructive action also opens a macOS dialog for the user to approve; tell them to expect it. For write and sensitive actions the dialog also offers "Always allow", which skips the dialog for that action on that site for 7 days; destructive actions ask every run. Give the Bash call a timeout of at least 4 minutes so a slow answer doesn't kill the run. A call they deny throws "Denied …": stop and ask them, don't retry or work around it.
   - `wf-mcp approvals` lists the actions the user chose to always allow. Only the user revokes them, with `/webflow-codemode:approvals clear [action]`; don't run `--clear` yourself, and never add, edit or remove entries in `<home>/approvals.json`.
   - `/webflow-codemode:status` shows the user the home in use, the login and the approvals; suggest it when they're unsure what's set up.
   - `Promise.all` over many calls is fine: the runner runs 4 at a time (`--concurrency`) and queues the rest.
   - Only `console.log` output comes back, capped at 20,000 characters (`--max-output`); past that you get the start and the end, with the full log saved in `out/`. Objects print as compact JSON. Write large results with `out.write()` instead, and print the path it returns.
   - Reads that hit Webflow's rate limit (429) are retried with backoff. Writes are not, because a tool may have applied part of the change; check the site before rerunning one.
   - `designer_tool`, `element_snapshot_tool` and image uploads by URL (`asset_tool`) need the site open in the Designer with the Webflow MCP Bridge App running in the foreground tab. Without it, `designer_tool` says "Unable to connect to Webflow Designer" and snapshots return `{"status": false}`. A snapshot's element must also be on the page open in the Designer, or the response is empty. Everything else runs headless.
   - Check `list_sites` to see which sites the login reaches.
   - Run snippets with a Bash timeout above the runner's `--timeout` (90s by default).
4. `wf-mcp run <home>/snippets/smoke-test.ts <siteId>` makes one read call per tool and lists what failed.
5. If the runner says the schemas changed, it has already regenerated `<home>/types/`. Tell the user what changed, especially any access levels it says were guessed (they're defaults from the action's name; whoever maintains the plugin should review them). Access levels are enforced by the binary itself; `types/index.md` only describes them. A run allowed to write stops with code 4 after a change; run it again once the user has seen the changes.

Exit codes: 0 ok, 1 the snippet threw, 2 bad usage or typecheck failure, 3 login needed, 4 schemas changed on a write run, 5 the project's `.wf-mcp/` isn't adopted, 124 timed out.
