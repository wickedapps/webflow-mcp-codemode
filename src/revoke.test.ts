import { afterAll, expect, test } from "bun:test";
import { revokeLogin } from "./revoke.ts";

// A stand-in for Webflow's OAuth server: revoking a refresh token makes it fail at the token endpoint, unless
// `ignoreRevocation` is set.
const revoked = new Set<string>();
const requests: Array<Record<string, string>> = [];
let ignoreRevocation = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({ revocation_endpoint: `${url.origin}/oauth/revoke`, token_endpoint: `${url.origin}/oauth/token` });
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    requests.push({ path: url.pathname, ...form });
    if (url.pathname === "/oauth/revoke") {
      if (!ignoreRevocation) revoked.add(form.token ?? "");
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/oauth/token") {
      if (revoked.has(form.refresh_token ?? "")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
    }
    return new Response(null, { status: 404 });
  },
});
afterAll(() => server.stop(true));
const origin = `http://localhost:${server.port}`;
const login = (tokens: object) => JSON.stringify({ client: { client_id: "c1" }, tokens });

test("revoking a login revokes both tokens and confirms the refresh token is dead", async () => {
  requests.length = 0;
  expect(await revokeLogin(login({ access_token: "a1", refresh_token: "r1" }), origin)).toBe("revoked");
  expect(requests.map((r) => [r.path, r.token ?? r.grant_type, r.client_id])).toEqual([
    ["/oauth/revoke", "r1", "c1"],
    ["/oauth/revoke", "a1", "c1"],
    ["/oauth/token", "refresh_token", "c1"],
  ]);
});

test("a server that ignores the revocation is reported, and the tokens the check got are revoked too", async () => {
  ignoreRevocation = true;
  requests.length = 0;
  expect(await revokeLogin(login({ access_token: "a2", refresh_token: "r2" }), origin)).toBe("still-active");
  expect(requests.slice(-2).map((r) => r.token)).toEqual(["new-refresh", "new-access"]);
  ignoreRevocation = false;
});

test("nothing to revoke without a client or tokens", async () => {
  expect(await revokeLogin(JSON.stringify({ tokens: { refresh_token: "r" } }), origin)).toBe("nothing");
  expect(await revokeLogin(JSON.stringify({ client: { client_id: "c" } }), origin)).toBe("nothing");
  expect(await revokeLogin(login({ access_token: "a3" }), origin)).toBe("unverified");
});
