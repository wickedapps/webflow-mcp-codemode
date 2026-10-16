# webflow-codemode

A Claude Code plugin for working on Webflow sites. Claude writes a short TypeScript snippet, and a sandboxed runner executes it against Webflow's hosted MCP server. Only what the snippet prints comes back to Claude, so bulk reads, loops, exports and batched CMS edits stay fast and out of the conversation. Writes need your approval in a macOS dialog.

The runner ships as a self-contained binary, so you don't need Bun, Node or `bun install` to use the plugin.

## Requirements

- Claude Code
- A Mac with Apple silicon (M1 or later). Intel Macs and other operating systems aren't supported.
- A Webflow account with access to the sites you want to work on

## Install

In Claude Code:

```
/plugin marketplace add wickedapps/webflow-mcp-codemode
/plugin install webflow-codemode@webflow-plugins
```

Restart Claude Code, or run `/reload-plugins`, to pick it up. To update later, run `/plugin marketplace update webflow-plugins`.

## Getting started

Type `/webflow-codemode:setup`. It explains how the plugin works, runs the login (a browser tab opens on Webflow's consent page, where you choose the workspace and sites to authorize), and tries a first read on your site: its sites, pages or CMS collections.

You can also skip it and just ask Claude for something on the site, for example "list the CMS collections on the site". The first time, Claude runs the login.

## Commands

Apart from `code`, Claude never runs these on its own.

| Command | Does |
| --- | --- |
| `/webflow-codemode:setup` | Walk through the plugin: how it works, where the login lives, the Webflow login, and a first read (sites, pages or CMS collections). Start here. |
| `/webflow-codemode:code <task>` | Do a Webflow task through a snippet. Claude also uses this on its own when a request involves Webflow. |
| `/webflow-codemode:login` | Log in, or check the login. `project` gives this project its own login; `force` switches workspaces. |
| `/webflow-codemode:logout` | Revoke the login for this project's home folder at Webflow, and delete it. |
| `/webflow-codemode:approvals` | List "Always allow" approvals; `clear [action]` revokes them. |
| `/webflow-codemode:status` | Show the home folder, login, sites it reaches and approvals. |

## Approvals

Reads run without asking. When a snippet wants to change something, a macOS dialog asks first. Nothing is sent until you choose, and Deny is the default.

- **Writes** (creates and updates) and **sensitive reads** (form submissions, emails, logs) offer *Deny*, *Allow this run* and *Always allow*. *Always allow* remembers that action on that site for 7 days, so later runs don't ask.
- **Destructive** actions (deletes, publishes, site-wide changes) offer only *Deny* or *Allow* and ask on every run.
- `/webflow-codemode:approvals` lists what you've always allowed; `/webflow-codemode:approvals clear` revokes everything, `clear <action>` one action.

Designer actions and element snapshots need the site open in the Webflow Designer with the Webflow MCP Bridge App running. Everything else works without the Designer.

## Logins and home folders

Your Webflow login is kept in the macOS Keychain, the way Claude Code keeps its own MCP logins, not in any folder: look for items named `wf-mcp` in Keychain Access. Approvals, the generated tool types, snippets and results live in a home folder. By default that's `~/.wf-mcp/`, shared by all your projects, and each home has its own login. `/webflow-codemode:logout` revokes the login for the current home at Webflow and deletes it; `login force` revokes the login it replaces.

To give one project its own Webflow login (say, a different client workspace), type `/webflow-codemode:login project` in it. That creates `.wf-mcp/` at the project root (the git root if there is one), and any run from inside that project uses it instead of `~/.wf-mcp/`. The folder ignores itself in git, and `init` signs it with a key only you have, so a `.wf-mcp/` folder that arrives with a repo or a zip isn't used until you adopt it with `/webflow-codemode:login project` (which deletes any login, approvals and types it came with). The lookup order is `$WF_MCP_HOME`, then the nearest `.wf-mcp/` in the current folder or a parent, then `~/.wf-mcp/`. `/webflow-codemode:status` shows the one in use.

## Development

You need [Bun](https://bun.sh) 1.3 or later on an Apple silicon Mac.

```
src/                          source, tests and build script
plugins/webflow-codemode/
  .claude-plugin/plugin.json
  skills/code/SKILL.md               the workflow Claude follows (/webflow-codemode:code)
  skills/{setup,login,logout,approvals,status}/SKILL.md   slash commands, user-only (disable-model-invocation)
  scripts/wf-mcp                     launcher: checks the Mac, then starts the binary
  scripts/wf-mcp-darwin-arm64        compiled runner (built, committed)
  scripts/typescript-darwin-arm64/   native TypeScript compiler used to typecheck snippets (copied, committed)
plugins/webflow-codemode.zip         the plugin, zipped (built, not committed)
.claude-plugin/marketplace.json
```

The built binary and compiler are committed, because Claude Code installs the plugin straight from this repository.

### Build and test

```sh
cd src
bun install
bun dev login            # log in to ~/.wf-mcp (or a signed WF_MCP_HOME), writes types/
bun test                 # access table, Keychain store, 401/429 detection, output limits, approval prompt
bun run build            # typecheck, compile the binary into plugins/webflow-codemode/scripts/, write the zip
bun run audit:ages       # check that every locked package is at least 24 hours old
```

`bun dev <command>` runs the CLI from source, with the same subcommands as the binary. The access table test needs a login, because it reads the types that `bun dev login` or `bun dev gen` writes.

`bun run build` signs the binary ad hoc. Without that step, macOS kills the binary as soon as it starts (exit 137).

### Releasing

1. Bump `version` in `plugins/webflow-codemode/.claude-plugin/plugin.json` and `VERSION` in `src/cli.ts`. The build stops if they differ. Installed copies are cached by version, so users only get changes after a bump.
2. Run `bun run build` and commit the rebuilt files in `plugins/webflow-codemode/scripts/`.
3. Tag the commit (`v1.0.0`) and optionally attach `plugins/webflow-codemode.zip` to a GitHub release, for anyone who installs from a zip.

### How it works

- A single `wf-mcp` command with the subcommands `init`, `login`, `logout`, `run`, `gen`, `approvals` and `home`.
- The login lives in the macOS Keychain: a generic password with service `wf-mcp` and the home's path as the account, plus `<path>#previous` for the login before it (`src/credentials.ts`). It's written through `security -i` on stdin so tokens never show in a process list.
- Other state lives in a home folder (`approvals.json`, `types/`, `snippets/`, `out/`, `support/`): a project's own `.wf-mcp/` if it has one, else `~/.wf-mcp/` (`src/paths.ts`).
- Each call's access level comes from the access table compiled into the binary (`buildManifest` in `src/gen-types.ts`), never from `types/manifest.json` on disk.
- Any home other than `~/.wf-mcp/` is used only if `init` signed it: an HMAC of its path, keyed by `~/.wf-mcp/.project-key` (`src/paths.ts`). That includes a folder named by `$WF_MCP_HOME`, since a repo's `.claude/settings.json` or `.envrc` can set it. Other folders make every command exit with code 5; `WF_MCP_HOME=<dir> wf-mcp init` signs one.
- `logout` and `login --force` revoke the login they discard at Webflow's revocation endpoint, then try its refresh token once to confirm it's dead (`src/revoke.ts`).
- Write and sensitive actions can be always allowed per action and site for 7 days (`src/trust.ts`); destructive ones can't. An agent with shell access could edit `approvals.json`, or read the Keychain item with `security` (items it created don't prompt), so the dialog stops mistakes, not a determined agent.
- Snippets have no network. To finish `create_asset`, `create_font` or `replace_font_file`, a snippet hands the runner a file in `out/` and that call's presigned S3 target (`out.upload`); the runner sends it only to a target one of those calls returned in the same run, and only to Amazon S3 over https (`src/upload.ts`).
- The QuickJS wasm, the sandbox globals and the example snippets are embedded in the binary. The TypeScript compiler ships beside it, and without the compiler snippets run unchecked.
- The access table is compiled in. When Webflow adds actions, their levels are guessed from the action names (writes and destructive calls still need approval). Review them with `bun dev gen`, add any needed overrides to `src/access.ts`, then rebuild.
- The launcher refuses anything but an Apple silicon Mac. The first time it runs after an install or update, it checks that macOS lets the binary start (restoring the executable bits if unzipping dropped them), and records the check in `scripts/.checked`. It sets `WF_MCP_PLUGIN=1`, so the binary's messages name slash commands like `/webflow-codemode:login` instead of `wf-mcp login`, which plugin users don't have on their PATH (`src/plugin.ts`).

### Skill permissions

Each skill's `allowed-tools` pre-approves the commands it runs, so they don't prompt in Claude Code's default mode. `${CLAUDE_PLUGIN_ROOT}` is filled in there. Bash rules end in ` *`, which also matches the bare command and covers arguments such as `--verbose`. The status skill keeps `approvals` exact, so `approvals --clear` still prompts there. File rules use `Edit(...)` for writes: Claude Code ignores path rules on `Write` and warns at startup. `Edit(./.wf-mcp/snippets/**)` counts from the folder Claude Code started in, so a project's own snippets are covered only when it starts at the project root. The `code` skill never pre-approves `login`, `logout`, `init` or `approvals --clear`. A compound command such as `W=…; "$W" home; echo $?` matches no rule, so every skill tells Claude to run each command on its own, written out in full. When Claude loads the `code` skill by itself, Claude Code asks once to use the skill; typing `/webflow-codemode:code` doesn't ask.

## License

[MIT](LICENSE)
