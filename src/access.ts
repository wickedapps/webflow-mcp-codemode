// Access level of every Webflow MCP action, used by run.ts to decide which calls a run may make.
// The levels come from OVERRIDES when listed there, otherwise from the action's name. Review this table
// when `wf-mcp gen` reports a new action whose level was guessed from its name.
//
//   read         reads site data
//   sensitive    reads personal data or secrets (form submissions, emails, env variables, logs)
//   write        creates or updates something
//   destructive  deletes, publishes, or changes something site-wide or hard to undo

export type Access = "read" | "sensitive" | "write" | "destructive";
export const ACCESS_LEVELS: Access[] = ["read", "sensitive", "write", "destructive"];

// Keyed by `tool.action`, or by tool name for tools without actions.
export const OVERRIDES: Record<string, Access> = {
  // Personal data and secrets.
  "data_forms_tool.list_form_submissions": "sensitive",
  "data_forms_tool.list_site_form_submissions": "sensitive",
  "data_forms_tool.get_form_submission": "sensitive",
  "data_comments_tool.search_comment_user_by_email": "sensitive",
  "data_apps_tool.list_variables": "sensitive",
  "data_apps_tool.get_runtime_logs": "sensitive",
  "data_apps_tool.get_build_logs": "sensitive",
  "data_enterprise_tool.list_site_activity_logs": "sensitive",
  "data_campaigns_tool.get_engaged_accounts": "sensitive",
  "data_campaigns_tool.get_opportunity_summary": "sensitive",
  "data_members_tool.list_site_members": "sensitive",
  "data_members_tool.list_workspace_members": "sensitive",

  // Sends a free-text description of the task to Webflow's team. Nothing on the site changes, but the text leaves.
  get_more_tools: "write",

  // Sends future site events, including form submissions, to any URL.
  "data_webhook_tool.create_webhook": "destructive",
  // Adds or replaces JavaScript that runs on every page after the next publish.
  "data_scripts_tool.add_site_script": "destructive",
  "data_scripts_tool.add_page_script": "destructive",
  "data_scripts_tool.register_hosted_script": "destructive",
  "data_scripts_tool.register_inline_script": "destructive",
  "data_scripts_tool.update_registered_script": "destructive",
  "data_scripts_tool.set_site_scripts": "destructive",
  "data_scripts_tool.set_page_scripts": "destructive",
  "data_scripts_tool.set_site_freeform_code": "destructive",
  "data_scripts_tool.set_page_freeform_code": "destructive",
  // Site-wide SEO and domain verification.
  "data_enterprise_tool.update_robots_txt": "destructive",
  "data_enterprise_tool.add_well_known_file": "destructive",
  // Bulk changes.
  "data_pages_tool.bulk_update_pages": "destructive",
  "data_pages_tool.bulk_update_pages_schema_markup": "destructive",
  "data_sitemap_tool.bulk_update_items_sitemap_status": "destructive",
  "data_sitemap_tool.bulk_update_pages_sitemap_status": "destructive",
  "data_campaigns_tool.bulk_update_page_variations": "destructive",
  // Who can see and edit the site or workspace. Granting a role can give someone admin or site manager access,
  // and revokes take effect at once and can't be undone through the API.
  "data_members_tool.grant_site_access": "destructive",
  "data_members_tool.revoke_site_access": "destructive",
  "data_members_tool.update_site_role": "destructive",
  "data_members_tool.invite_workspace_member": "destructive",
  "data_members_tool.update_workspace_role": "destructive",
  "data_members_tool.bulk_update_workspace_roles": "destructive",
  // Replaces each asset's file in place; the original isn't kept.
  "data_assets_tool.compress_assets": "destructive",

  // Only move the Designer's view; nothing on the site changes.
  "designer_tool.select_element": "read",
  "designer_tool.switch_page": "read",
  "designer_tool.open_canvas": "read",
  "designer_tool.open_component_view": "read",
  "designer_tool.close_component_view": "read",
};

const DESTRUCTIVE = /^(delete|remove|publish|unpublish|clear|merge|batch_delete|unlink_delete|unregister|replace|reset)_|^(redeploy|trigger_deployment)$/;
const READ = /^(get|list|query|search|read|check_if)_|^guide$/;

// Level from the action's name alone. Anything that matches neither pattern counts as a write.
export function nameAccess(action: string): Access {
  if (DESTRUCTIVE.test(action)) return "destructive";
  if (READ.test(action)) return "read";
  return "write";
}

// An action's level, and whether it was guessed from the name rather than listed in OVERRIDES.
export function actionAccess(tool: string, action: string): { access: Access; guessed: boolean } {
  const listed = OVERRIDES[`${tool}.${action}`];
  return listed ? { access: listed, guessed: false } : { access: nameAccess(action), guessed: true };
}

// A tool without actions: OVERRIDES, else its readOnlyHint annotation.
export function toolAccess(tool: string, readOnlyHint: boolean | undefined): Access {
  return OVERRIDES[tool] ?? (readOnlyHint ? "read" : "write");
}

const isAccess = (value: string): value is Access => (ACCESS_LEVELS as string[]).includes(value);

// The levels a run may use, from --allow. Reads are always allowed; destructive implies write.
export function parseAllow(value: string): Set<Access> {
  const allowed = new Set<Access>(["read"]);
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!isAccess(part)) {
      throw new Error(`--allow takes a comma-separated list of: ${ACCESS_LEVELS.join(", ")} (got "${part}")`);
    }
    allowed.add(part);
    if (part === "destructive") allowed.add("write");
  }
  return allowed;
}
