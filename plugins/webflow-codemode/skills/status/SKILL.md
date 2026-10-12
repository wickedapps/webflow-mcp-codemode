---
name: status
description: Show the webflow-codemode plugin's state for this project - which home folder and login it uses, the sites the login reaches, and the always-allowed actions.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp --version *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp home *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp approvals) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp run *)
---

# Webflow status

`wf-mcp` below means `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp`; always use the full path, from the project's directory. Everything here is read-only. Run each `wf-mcp` command as its own Bash call, written out in full: no shell variables, `;`, `&&`, pipes, `echo` or `$?`. Only a plain command matches the ones this skill pre-approves; anything else makes the user approve it. A failing command's exit code is reported anyway.

1. Run `wf-mcp --version` and `wf-mcp home --verbose`.
2. Run `wf-mcp run <home>/snippets/list-sites.ts`, where `<home>` is the folder `home` printed, with a Bash timeout of 2 minutes.
   - Exit 3: not logged in for this home.
   - Exit 5: the project has a `.wf-mcp/` folder this user didn't set up on this machine; it isn't used until adopted with `/webflow-codemode:login project`.
3. Run `wf-mcp approvals`.

Report briefly:
- **Version** and **home folder**: this project's own `.wf-mcp/` or the shared `~/.wf-mcp`.
- **Login**: logged in or not; the login is kept in the macOS Keychain. List the sites it reaches.
- **Always allowed**: the actions, sites and expiry dates, or "none".
- **Next step**, if any: `/webflow-codemode:login` to log in (`/webflow-codemode:login project` for a project-only login), `/webflow-codemode:approvals clear` to revoke approvals.
