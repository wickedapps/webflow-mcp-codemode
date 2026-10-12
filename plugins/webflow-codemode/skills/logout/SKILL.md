---
name: logout
description: Revoke and delete the Webflow login the webflow-codemode plugin uses for this project.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp home *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp logout *)
---

# Log out of Webflow

The user asked to log out. `wf-mcp` below means `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp`; always use the full path, from the project's directory. Run each `wf-mcp` command as its own Bash call, written out in full: no shell variables, `;`, `&&`, pipes, `echo` or `$?`. Only a plain command matches the ones this skill pre-approves; anything else makes the user approve it. A failing command's exit code is reported anyway.

1. Run `wf-mcp home --verbose` to see which home folder is in use: this project's own `.wf-mcp/`, or the shared `~/.wf-mcp` that every project without its own uses.
2. Run `wf-mcp logout` with a Bash timeout of 2 minutes. It revokes the login at Webflow, checks the revocation took, and deletes it from the macOS Keychain, along with the previous login kept as a fallback. The local copy is deleted even if Webflow can't be reached.
3. Report which home was logged out, and if it was the shared `~/.wf-mcp`, that this affects every project without its own login. Relay what it printed about the revocation: if it says Webflow couldn't be reached or didn't revoke the login, tell them to remove the app in Webflow's workspace settings. `/webflow-codemode:login` logs in again.
