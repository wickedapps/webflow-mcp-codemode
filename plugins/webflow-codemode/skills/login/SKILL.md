---
name: login
description: Log in to Webflow for the webflow-codemode plugin, or give this project its own Webflow login.
argument-hint: "[project] [force]"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp home *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp login *) Bash(${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp init *)
---

# Log in to Webflow

The user asked to log in. Arguments: `$ARGUMENTS`. `wf-mcp` below means `${CLAUDE_PLUGIN_ROOT}/scripts/wf-mcp`; always use the full path, from the project's directory. Run each `wf-mcp` command as its own Bash call, written out in full: no shell variables, `;`, `&&`, pipes, `echo` or `$?`. Only a plain command matches the ones this skill pre-approves; anything else makes the user approve it. A failing command's exit code is reported anyway.

1. Run `wf-mcp home --verbose`. It prints the home folder in use and, on stderr, whether it's a project's own folder or the shared `~/.wf-mcp`.
2. If the arguments include `project`, or the user said they want this project to have its own login, and the home isn't already this project's, run `wf-mcp init`. It creates `.wf-mcp/` at the project root (the git root if there is one).
   If `home` said the folder isn't used until adopted, or a command exits with code 5, the project has a `.wf-mcp/` folder that this user didn't set up on this machine. Explain that, and run `wf-mcp init` only if they confirm: adopting deletes any login, approvals and types it came with.
3. Tell the user a browser tab will open on Webflow's consent page, where they choose the workspace and sites to authorize. If they're already logged in, no browser opens and the command just confirms the login.
4. Run `wf-mcp login`, or `wf-mcp login --force` if the arguments include `force` or the user wants to switch workspaces. Once a `--force` login succeeds, the login it replaced is revoked at Webflow. Give the Bash call a timeout of 6 minutes: it waits up to 5 minutes for the browser.
5. Report which home the login is for, that it's stored in the macOS Keychain, and the sites it reaches. After a new login it also prints "What to expect": pass those points on in your own words. If it failed or timed out, say so and show the error.
