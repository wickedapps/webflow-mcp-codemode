---
name: setup
description: Set up the webflow-codemode plugin - explain how it works, log in to Webflow, and try a first read on a site.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp home *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp login *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp init *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp run *)
---

# Set up webflow-codemode

The user asked to set up the plugin. Guide them through it one step at a time, briefly, in your own words. `wf-mcp` below means `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp`; always use the full path, from the project's directory. Run each `wf-mcp` command as its own Bash call, written out in full: no shell variables, `;`, `&&`, pipes, `echo` or `$?`. Only a plain command matches the ones this skill pre-approves; anything else makes the user approve it. A failing command's exit code is reported anyway.

## 1. Explain the plugin

Tell the user, in a few short lines:
- They ask for things on their Webflow site in plain language ("list the CMS collections", "find every page that mentions pricing"). Claude writes a short TypeScript snippet and runs it in a sandbox against Webflow's MCP server, and only what the snippet prints comes back. That keeps bulk reads, loops and exports fast and out of the conversation.
- Reads run without asking. Creates, updates, deletes, publishes and reads of personal data (form submissions, emails, logs) open a macOS dialog first, and Deny is the default. Writes and sensitive reads can be "Always allow"ed for 7 days per action and site; deletes and publishes ask every time.
- Designer actions and element snapshots need the site open in the Webflow Designer with the Webflow MCP Bridge App running. Everything else works without the Designer.
- The commands: `/webflow-codemode:code <task>` (Claude also does this on its own when a request involves Webflow), `/webflow-codemode:login`, `/webflow-codemode:logout`, `/webflow-codemode:approvals`, `/webflow-codemode:status`, and this one.

## 2. Choose where the login lives

1. Run `wf-mcp home --verbose`. It prints the home folder in use and, on stderr, whether it's this project's own folder or the shared `~/.wf-mcp`.
2. If `home` said the folder isn't used until adopted, or a command exits with code 5, the project has a `.wf-mcp/` folder that this user didn't set up on this machine (it may have come with a repo or a zip). Explain that, and run `wf-mcp init` only if they confirm: adopting deletes any login, approvals and types it came with. If they don't, stop here and suggest they delete the folder or run `/webflow-codemode:setup` again once they decide.
3. If the home is the shared `~/.wf-mcp`, ask the user (with AskUserQuestion) which they want:
   - **Shared login** (recommended): one Webflow login for every project on this Mac that doesn't have its own.
   - **This project only**: a separate login for this project, for example a different client's workspace. Run `wf-mcp init`, which creates `.wf-mcp/` at the project root (the git root if there is one); the folder ignores itself in git.
   If the home is already this project's own, or `$WF_MCP_HOME`, keep it and say which it is.

## 3. Log in

1. Tell the user a browser tab will open on Webflow's consent page, where they choose the workspace and the sites to authorize. One login covers one workspace. If they're already logged in, no browser opens and the command just confirms it.
2. Run `wf-mcp login` with a Bash timeout of 6 minutes: it waits up to 5 minutes for the browser.
3. If it failed or timed out, show the error and stop; they can run `/webflow-codemode:setup` again. Otherwise report which home the login is for, that it's kept in the macOS Keychain, and the sites it reaches (it lists their IDs and names). If no sites are listed, tell them to run `/webflow-codemode:login force` and authorize at least one site.

## 4. Try it

Offer a first read with AskUserQuestion. Use the site names from the login output; if the login reaches more than one site, ask which site first (up to 4 options, the user can type another).
- **List all sites** the login reaches.
- **List all pages** on the site.
- **List all CMS collections** on the site, with item counts.

Run the one they pick with a Bash timeout of 2 minutes, where `<home>` is the folder `home` printed and `<siteId>` is the site's ID from the login output:
- `wf-mcp run <home>/snippets/examples/list-sites.ts`
- `wf-mcp run <home>/snippets/examples/list-pages.ts <siteId>`
- `wf-mcp run <home>/snippets/examples/list-collections.ts <siteId>`

Summarize the result readably (a short table or list, not the raw IDs unless they're useful). If a run exits with code 3, the login didn't take: suggest `/webflow-codemode:login`.

## 5. Wrap up

Tell the user setup is done and suggest a few things to ask next, made specific to their site where you can, for example:
- "Export every item in the Blog collection to a CSV"
- "Find every page that mentions <a phrase>"
- "Which CMS items are still drafts?"
- "Update the SEO description on <a page>" (a write: a macOS dialog asks first)

Mention `/webflow-codemode:status` for checking the setup later.
