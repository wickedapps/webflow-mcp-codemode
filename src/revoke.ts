// Revoke a login at Webflow, so deleting it locally (`wf-mcp logout`, or replacing it with `wf-mcp login --force`)
// doesn't leave the authorization alive on Webflow's side. Uses the revocation endpoint Webflow's MCP server
// advertises (RFC 7009), then tries the refresh token once to check it no longer works.

export const DEFAULT_SERVER = "https://mcp.webflow.com";

export type RevokeResult =
  // Webflow refuses the refresh token now.
  | "revoked"
  // There was no token, or no client to revoke it for.
  | "nothing"
  // Only an access token, so there was nothing to check the revocation with.
  | "unverified"
  // The refresh token still worked after the revocation.
  | "still-active";

interface Login {
  client?: { client_id?: string; client_secret?: string };
  tokens?: { access_token?: string; refresh_token?: string };
}

async function endpoints(server: string): Promise<{ revoke: string; token: string }> {
  const res = await fetch(new URL("/.well-known/oauth-authorization-server", server));
  if (!res.ok) throw new Error(`Couldn't read Webflow's OAuth metadata (HTTP ${res.status}).`);
  const meta = (await res.json()) as { revocation_endpoint?: string; token_endpoint?: string };
  if (!meta.revocation_endpoint || !meta.token_endpoint) throw new Error("Webflow's OAuth server doesn't advertise token revocation.");
  return { revoke: meta.revocation_endpoint, token: meta.token_endpoint };
}

const post = (url: string, form: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

// `text` is a stored login as credentials.ts keeps it. Throws when Webflow can't be reached.
export async function revokeLogin(text: string, server = DEFAULT_SERVER): Promise<RevokeResult> {
  const login = JSON.parse(text) as Login;
  const client_id = login.client?.client_id;
  const { access_token, refresh_token } = login.tokens ?? {};
  if (!client_id || (!access_token && !refresh_token)) return "nothing";
  const auth: Record<string, string> = { client_id, ...(login.client?.client_secret ? { client_secret: login.client.client_secret } : {}) };
  const { revoke, token } = await endpoints(server);

  const revokeAll = async (tokens: { access_token?: string; refresh_token?: string }) => {
    // The refresh token first: revoking it ends the whole grant on servers that tie the two together.
    if (tokens.refresh_token) await post(revoke, { ...auth, token: tokens.refresh_token, token_type_hint: "refresh_token" });
    if (tokens.access_token) await post(revoke, { ...auth, token: tokens.access_token, token_type_hint: "access_token" });
  };
  await revokeAll({ access_token, refresh_token });
  if (!refresh_token) return "unverified";

  // The revocation endpoint answers 200 even for tokens it didn't know, so check by trying the refresh token.
  const check = await post(token, { ...auth, grant_type: "refresh_token", refresh_token });
  if (!check.ok) return "revoked";
  // It still worked, and issued new tokens: revoke those too rather than leave them alive.
  await revokeAll((await check.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string });
  return "still-active";
}

export function describeRevoke(result: RevokeResult): string {
  switch (result) {
    case "revoked":
      return "revoked at Webflow";
    case "nothing":
      return "nothing to revoke at Webflow";
    case "unverified":
      return "revocation sent to Webflow (couldn't be checked)";
    case "still-active":
      return "Webflow didn't revoke it; remove the app in Webflow's workspace settings";
  }
}
