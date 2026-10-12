// The plugin's launcher (scripts/wf-mcp) sets WF_MCP_PLUGIN=1. A plugin user doesn't have the binary on their PATH,
// so messages that say what to do next name the slash command they type in Claude Code instead.
export const IN_PLUGIN = process.env.WF_MCP_PLUGIN === "1";

const SLASH = { login: "/webflow-codemode:login", init: "/webflow-codemode:login project" } as const;

// How the user runs `wf-mcp <command>`, to finish a sentence: "To log in, <howToRun("login")>."
export function howToRun(command: keyof typeof SLASH): string {
  return IN_PLUGIN ? `type \`${SLASH[command]}\` in Claude Code` : `run \`wf-mcp ${command}\` in a terminal`;
}
