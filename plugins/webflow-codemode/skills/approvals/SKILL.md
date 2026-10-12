---
name: approvals
description: List or revoke the Webflow write and sensitive actions you chose to "Always allow" in the webflow-codemode plugin.
argument-hint: "[clear [action]]"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp home *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp approvals *)
---

# Webflow approvals

Arguments: `$ARGUMENTS`. `wf-mcp` below means `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp`; always use the full path, from the project's directory. Run each `wf-mcp` command as its own Bash call, written out in full: no shell variables, `;`, `&&`, pipes, `echo` or `$?`. Only a plain command matches the ones this skill pre-approves; anything else makes the user approve it. A failing command's exit code is reported anyway.

"Always allow" lets a write or sensitive action run on a site without the macOS approval dialog for 7 days. Approvals belong to the home folder in use (`wf-mcp home --verbose` shows which). Destructive actions are never kept.

- **No arguments:** run `wf-mcp approvals` and show the list as a short table: action, level, site ("any" when the call names no site) and when it expires.
- **`clear`:** run `wf-mcp approvals --clear` to revoke them all.
- **`clear <action>`:** run `wf-mcp approvals --clear <action>` for that one action, for example `data_cms_tool.update_collection_items`. If the name doesn't match an entry exactly, list the approvals first and ask which one they meant.

After clearing, say how many were revoked and that those actions will ask again on their next run. Never edit `approvals.json` directly.
