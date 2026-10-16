---
name: code
description: Read or change Webflow site data (CMS collections and items, pages, styles, components, assets, forms, Designer elements) by writing a short TypeScript snippet and running it in a sandbox, instead of calling Webflow MCP tools one at a time. Use for bulk reads, exports, audits, finding text across a site, loops and joins across collections, and batched CMS edits.
argument-hint: "<task>"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp run *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp home *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp snippets *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp types *) Read(~/.wf-mcp/**) Edit(~/.wf-mcp/snippets/**) Edit(./.wf-mcp/snippets/**)
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

1. Run `wf-mcp snippets`. It lists the snippets saved in this home by the user or earlier sessions, then the plugin's examples, each with its header comment. If a saved snippet does the job, run it with new arguments instead of writing a new one. If one is close, extend it or copy it.
2. Find the tool and action in `<home>/types/index.md`. Run `wf-mcp types <tool>.<action>` (several names at once is fine) for each action whose inputs you haven't seen yet. It prints only that action's docs and signature, a few thousand characters, where `<home>/types/<tool>.ts` holds every action of the tool. Do it even when a snippet already shows the call, if you need anything beyond what that snippet passes: snippets use few options. Let Webflow narrow results where it can instead of fetching everything and filtering in the snippet. For example, `list_collection_items` takes `request.filter` on custom fields (`eq`, `in`, `contains`, `gte`, `exists`, …; reference fields match item IDs) and `request.sort`.
3. Write the snippet:
   - One worth keeping, for a task that may come up again (a lookup, report, audit or batch edit), goes in `<home>/snippets/` or a topic subfolder, named for what it does. Start it with a header comment: a first line saying what it does, then the command that runs it (`//   wf-mcp run <home>/snippets/<path> <args>`), then any notes on output files. `wf-mcp snippets` shows these lines to later sessions. Take values that change between runs (a site ID, a field value, a date) as `args` rather than writing them in. When a later task needs a saved snippet to do more, update that snippet rather than saving a near copy.
   - Exploration and one-offs go in `<home>/snippets/scratch/`, which isn't listed.
   - Leave `<home>/snippets/examples/` alone: the plugin rewrites it on every update. Copy an example out before changing it.
   - A snippet is a module (`export {};` if it has no imports) that runs in a QuickJS sandbox, not Node or Bun. Its globals are `webflow`, `console`, `args` (its arguments), `out` (`out.write(name, data)`, `out.read(name)`, `out.md5(name)` and `out.upload(name, target)` for files in `<home>/out/`) and `sleep(ms)`; see `<home>/support/globals.d.ts`. It can import `.ts` files from its own folder, but no packages or `node:` modules, and it has no `fetch`.
   - `await webflow.data_cms_tool.list_collection_items({ collection_id, request: { limit: 100 } })` calls one action and returns its result, or throws the action's error.
   - Tools with tool-level args take them second: `webflow.data_style_tool.query_styles(input, { siteId, pageId })`.
   - Tools without actions are called directly: `webflow.webflow_guide_tool()`.
   - Results are `unknown` unless you pass a type: `list_sites<{ sites: Site[] }>()`. That type is taken on trust, so declare only the fields the snippet uses, typed as narrowly as you know them. For CMS items, type the `fieldData` keys you read from the collection's fields (`get_collection_details`) rather than `Record<string, any>`. Don't use `any` or `as`; narrow `unknown` with `typeof`, `in` or `Array.isArray`, and in a `catch`, use `err instanceof Error ? err.message : String(err)`.
   - The typecheck treats a missing array element or record key as possibly `undefined` (`args[0]`, `items[0]`, `fieldData[slug]`). Check it and throw a clear error rather than reaching for `!`: `const [siteId] = args; if (!siteId) throw new Error("Usage: …");`.
   - Check every value going into a write before the call: IDs present, the number of matches what you expect, the new values in the right shape. Throw rather than write a partial or guessed change.
   - A saved snippet that writes does a dry run by default: it prints what it would change and writes only when given an `apply` argument (`const apply = args.includes("apply");`). Show the user the dry run, then run it with `apply` and `--allow write`. The approval dialog shows how many things change, not what.
   - `designer_tool` actions resolve to their `data` (e.g. `get_current_page(true, { siteId })` gives `{ id, pageName, ... }`).
   - Calls that return images (`element_snapshot_tool`) resolve to `{ images, result }`: `images` are PNG paths in `<home>/out/`. Read them to see the snapshot. `snippets/examples/snapshot.ts <siteId>` is an example.
4. `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp run <home>/snippets/<file>.ts [args...]`. Extra arguments reach the snippet as `args`. The runner typechecks the snippet first and exits with code 2 on type errors; fix them rather than passing `--no-check`.
   - Read calls only by default. `--allow sensitive` permits reads of personal data and secrets (form submissions, emails, env variables, logs), `--allow write` creates and updates, `--allow destructive` deletes, publishes and site-wide changes; combine them with commas. Ask the user before using any of them. `types/index.md` shows each action's level.
   - The first call of each sensitive, write or destructive action also opens a macOS dialog for the user to approve; tell them to expect it. For write and sensitive actions the dialog also offers "Always allow", which skips the dialog for that action on that site for 7 days; destructive actions ask every run. Give the Bash call a timeout of at least 4 minutes so a slow answer doesn't kill the run. A call they deny throws "Denied …": stop and ask them, don't retry or work around it.
   - `wf-mcp approvals` lists the actions the user chose to always allow. Only the user revokes them, with `/webflow-codemode:approvals clear [action]`; don't run `--clear` yourself, and never add, edit or remove entries in `<home>/approvals.json`.
   - `/webflow-codemode:status` shows the user the home in use, the login and the approvals; suggest it when they're unsure what's set up.
   - `Promise.all` over many calls is fine: the runner runs 4 at a time (`--concurrency`) and queues the rest.
   - Only `console.log` output comes back, capped at 20,000 characters (`--max-output`); past that you get the start and the end, with the full log saved in `out/`. Objects print as compact JSON. Write large results with `out.write()` instead, and print the path it returns.
   - Reads that hit Webflow's rate limit (429) are retried with backoff. Writes are not, because a tool may have applied part of the change; check the site before rerunning one.
   - `designer_tool`, `element_snapshot_tool` and image uploads by URL (`asset_tool`) need the site open in the Designer with the Webflow MCP Bridge App running in the foreground tab. Without it, `designer_tool` says "Unable to connect to Webflow Designer" and snapshots return `{"status": false}`. A snapshot's element must also be on the page open in the Designer, or the response is empty. Everything else runs headless.
   - Check `list_sites` to see which sites the login reaches. Actions that take a `workspace_id` (such as `data_members_tool`) may point you to `data_workspaces_tool`; if that tool isn't in `types/index.md`, take `workspaceId` from `list_sites` or `get_site` instead.
   - To upload a file from the user's machine as an asset or font, copy it into `<home>/out/` first (snippets can't reach anything else). Pass `out.md5(name)` as the `file_hash` of `create_asset`, `create_font` or `replace_font_file`, then `await out.upload(name, result)` with that call's result to send the bytes. The runner only uploads to a target one of those calls returned in the same run. Images already online can go through `asset_tool.upload_image_by_url` instead.
   - Run snippets with a Bash timeout above the runner's `--timeout` (90s by default).
5. `wf-mcp run <home>/snippets/examples/smoke-test.ts <siteId>` makes one read call per tool and lists what failed.
6. If the runner says the schemas changed, it has already regenerated `<home>/types/`. Tell the user what changed, especially any access levels it says were guessed (they're defaults from the action's name; whoever maintains the plugin should review them). Access levels are enforced by the binary itself; `types/index.md` only describes them. A run allowed to write stops with code 4 after a change; run it again once the user has seen the changes.

Exit codes: 0 ok, 1 the snippet threw, 2 bad usage or typecheck failure, 3 login needed, 4 schemas changed on a write run, 5 the project's `.wf-mcp/` isn't adopted, 124 timed out.
