// Programmatic client for Webflow's hosted MCP server. Works for any Webflow project:
// each caller names itself, and the OAuth client and tokens are kept by credentials.ts (the macOS Keychain).
import http from "node:http";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentialStore, restorePrevious, setAside, type CredentialStore } from "./credentials.ts";
import { howToRun } from "./plugin.ts";

export interface ConnectOptions {
  // Short slug for this caller, e.g. "acme-cms-sync". Shown on the Webflow consent screen and sent as agent_id.
  name: string;
  // Default `context` sent with every call (15-25 words on why the calls are made). Overridable per call.
  context?: string;
  // Where the OAuth client and tokens are kept. Defaults to the Keychain item for the runner's home (credentials.ts).
  store?: CredentialStore;
  // Local port for the OAuth callback. Defaults to 8765.
  port?: number;
  // MCP endpoint. Defaults to Webflow's hosted server.
  serverUrl?: string;
  // Whether a browser login may start when the stored one is missing or rejected. Defaults to true only when
  // stdin and stdout are a terminal, so a script run by an agent fails fast with LoginRequiredError instead
  // of waiting minutes for a browser step nobody is watching.
  login?: boolean;
  // Called when a browser login starts and ends, e.g. so a caller can pause its own timeouts.
  onLogin?: (phase: "start" | "end") => void;
}

// Thrown when a browser login is needed but not allowed (see ConnectOptions.login).
export class LoginRequiredError extends Error {
  constructor(reason: string) {
    super(`${reason} To log in, ${howToRun("login")}, then try again.`);
    this.name = "LoginRequiredError";
  }
}

interface AuthStore {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

// A connected MCP client plus the per-run session state the Webflow server requires.
export interface WebflowMcp {
  client: Client;
  agentId: string;
  sessionId: string;
  context: string;
  // How far recovery from a 401 has gone this run: 0 none, 1 tokens refreshed, 2 new browser login.
  authStage: number;
  // Move recovery one stage on after a 401: refresh the tokens, then log in again in the browser.
  // `seen` is the stage the failed call started at; if another call already moved it on, this returns at once.
  // Throws LoginRequiredError when a browser login is needed but not allowed, and an error after stage 2.
  recover(seen: number): Promise<void>;
  // Set when recovery failed; every later call throws it instead of trying again.
  failure?: Error;
}

// The login is read once and then kept in memory; this process is the only one changing it during a run.
function createProvider(
  name: string,
  store: CredentialStore,
  redirect: string,
  allowBrowser: () => boolean,
): OAuthClientProvider & { forget(): void } {
  let cache: AuthStore | undefined;
  const load = (): AuthStore => {
    if (!cache) {
      const text = store.get();
      cache = text ? (JSON.parse(text) as AuthStore) : {};
    }
    return cache;
  };
  const write = (data: AuthStore) => {
    store.set(JSON.stringify(data));
    cache = data;
  };
  const save = (patch: AuthStore) => write({ ...load(), ...patch });
  // Before the stored login is changed or replaced, the previous copy is kept (credentials.ts).
  const backup = () => {
    const text = store.get();
    if (text !== undefined) store.set(text, "previous");
  };

  return {
    // Drop the in-memory copy after the stored login was changed from outside the provider.
    forget: () => {
      cache = undefined;
    },
    get redirectUrl() { return redirect; },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: name,
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => load().client,
    saveClientInformation: (client) => save({ client }),
    tokens: () => load().tokens,
    saveTokens: (tokens) => save({ tokens }),
    saveCodeVerifier: (codeVerifier) => save({ codeVerifier }),
    codeVerifier: () => {
      const verifier = load().codeVerifier;
      if (!verifier) throw new Error("No PKCE code verifier saved; restart the login.");
      return verifier;
    },
    // The SDK calls this when the server rejects the stored client or refresh token (e.g. access was revoked).
    invalidateCredentials: (scope) => {
      backup();
      if (scope === "all") {
        store.remove();
        cache = undefined;
        return;
      }
      const data = load();
      if (scope === "client") delete data.client;
      if (scope === "tokens") delete data.tokens;
      if (scope === "verifier") delete data.codeVerifier;
      write(data);
    },
    redirectToAuthorization: (url) => {
      if (!allowBrowser()) throw new LoginRequiredError("Webflow needs a new login.");
      console.error(`\nOpen this URL to authorize Webflow:\n${url}\n`);
      execFile("open", [url.toString()]);
    },
  };
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;

function waitForCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for the Webflow login."));
    }, LOGIN_TIMEOUT_MS);
    const server = http
      .createServer((req, res) => {
        const u = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (u.pathname !== "/callback") return res.end();
        const code = u.searchParams.get("code");
        const error = u.searchParams.get("error");
        res.end(code ? "Authorized. You can close this tab." : `Error: ${error}`);
        clearTimeout(timer);
        server.close();
        code ? resolve(code) : reject(new Error(error ?? "OAuth callback had no code"));
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .listen(port);
  });
}

export async function connect(options: ConnectOptions): Promise<WebflowMcp> {
  const { name, port = 8765 } = options;
  const serverUrl = new URL(options.serverUrl ?? "https://mcp.webflow.com/mcp");
  const store = options.store ?? credentialStore();
  const allowLogin = options.login ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Refreshing tokens must never open the browser, so it switches browser logins off while it runs.
  let refreshing = false;
  const provider = createProvider(name, store, `http://localhost:${port}/callback`, () => allowLogin && !refreshing);
  const newClient = () => new Client({ name, version: "1.0.0" });
  const newTransport = () => new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });

  // Connect with the stored tokens. With none (first run, or the refresh failed), finish the browser
  // OAuth flow, then reconnect.
  const open = async (): Promise<Client> => {
    const client = newClient();
    try {
      await client.connect(newTransport());
      return client;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }
    options.onLogin?.("start");
    try {
      const code = await waitForCode(port);
      await newTransport().finishAuth(code);
    } finally {
      options.onLogin?.("end");
    }
    const fresh = newClient();
    await fresh.connect(newTransport());
    return fresh;
  };

  // Exchange the stored refresh token for new tokens. False when there is none or Webflow refuses it.
  const refresh = async (): Promise<boolean> => {
    if (!(await provider.tokens())?.refresh_token) return false;
    refreshing = true;
    try {
      return (await auth(provider, { serverUrl })) === "AUTHORIZED";
    } catch {
      return false;
    } finally {
      refreshing = false;
    }
  };

  // A new browser login. The old login is moved aside first and put back if the new one doesn't finish.
  const browserLogin = async (): Promise<Client> => {
    if (!allowLogin) throw new LoginRequiredError("Webflow still rejects the stored login (401) after refreshing it, so access was probably revoked.");
    console.error("\nWebflow rejected the stored login (401), so access was probably revoked. Log in again in the browser.");
    const hadStore = setAside(store);
    provider.forget();
    try {
      return await open();
    } catch (err) {
      if (hadStore) restorePrevious(store);
      provider.forget();
      throw err;
    }
  };

  let pending: Promise<void> | undefined;
  const mcp: WebflowMcp = {
    client: await open(),
    // The server attributes calls by agent_id: one stable value per run.
    agentId: `script|${name}|${Math.random().toString(36).slice(2, 7)}`,
    sessionId: "start",
    context:
      options.context ??
      `Script "${name}" is calling Webflow MCP tools programmatically on behalf of its user to read or update this Webflow site's data.`,
    authStage: 0,
    recover(seen) {
      if (mcp.failure) return Promise.reject(mcp.failure);
      if (seen !== mcp.authStage) return pending ?? Promise.resolve();
      if (mcp.authStage >= 2) return Promise.reject(new Error(RELOGIN_FAILED));
      pending = (async () => {
        await mcp.client.close().catch(() => {});
        if (mcp.authStage === 0 && (await refresh())) {
          mcp.client = await open();
          mcp.authStage = 1;
        } else {
          mcp.client = await browserLogin();
          mcp.authStage = 2;
        }
        mcp.sessionId = "start";
      })()
        .catch((err: Error) => {
          mcp.failure = err;
          throw err;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
  return mcp;
}

// One action's result: tools echo the label and action name, then either result or error.
export interface ActionResult<T = unknown> {
  label: string;
  action: string;
  result?: T;
  error?: { name: string; message: string; status?: number; code?: string };
}

export interface CallOptions {
  // Retry when Webflow answers 429, waiting 2, 4, 8, 16 and 32 seconds. Default true. Turn it off for writes:
  // a tool that makes several API requests may have applied some changes before the one that was limited.
  retryRateLimit?: boolean;
}

// A tool's output: its text parts joined, plus any images (element snapshots return a PNG).
export interface CallOutput {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

// Call a tool and return its text output. Use callOutput() for tools that return images.
export async function callText(
  mcp: WebflowMcp,
  name: string,
  args: Record<string, unknown>,
  context = mcp.context,
  options: CallOptions = {},
): Promise<string> {
  return (await callOutput(mcp, name, args, context, options)).text;
}

// Call a tool and return its text and images. Adds the session_id, agent_id and context the server requires.
// The first call's output starts with a separate content part that issues the session ID; it is dropped here.
// If Webflow answers 401, the tokens are refreshed and the call retried; if it still gets 401, the user logs
// in again in the browser (when allowed) and the call is retried once more.
export async function callOutput(
  mcp: WebflowMcp,
  name: string,
  args: Record<string, unknown>,
  context = mcp.context,
  { retryRateLimit = true }: CallOptions = {},
): Promise<CallOutput> {
  let waits = 0;
  for (;;) {
    if (mcp.failure) throw mcp.failure;
    const stage = mcp.authStage;
    const result = await attempt(mcp, name, args, context);
    if (result === UNAUTHORIZED) {
      await mcp.recover(stage).catch((err: Error) => {
        throw err instanceof LoginRequiredError ? err : new Error(`${name}: ${err.message}`);
      });
      continue;
    }
    if (result !== RATE_LIMITED) return result;
    if (!retryRateLimit) throw new Error(`${name}: ${RATE_LIMITED_WRITE}`);
    if (waits === RATE_LIMIT_DELAYS.length) throw new Error(`${name}: Webflow is still rate limiting after ${waits} retries.`);
    const delay = RATE_LIMIT_DELAYS[waits++];
    console.error(`[webflow-mcp] ${name} was rate limited (429); retrying in ${delay}s.`);
    await new Promise((r) => setTimeout(r, delay * 1000));
  }
}

const UNAUTHORIZED = Symbol("unauthorized");
const RATE_LIMITED = Symbol("rate limited");
const RATE_LIMIT_DELAYS = [2, 4, 8, 16, 32];
const RELOGIN_FAILED =
  "Webflow still answers 401 after a new login. Check that this site was selected on the Webflow consent screen.";
const RATE_LIMITED_WRITE =
  "Webflow rate limited this call (429). It was not retried because it changes data and may have partly run: check the site before running it again.";

// One call. Returns UNAUTHORIZED when the MCP login or the Webflow data API rejects the credentials,
// and RATE_LIMITED when Webflow answers 429.
async function attempt(
  mcp: WebflowMcp,
  name: string,
  args: Record<string, unknown>,
  context: string,
): Promise<CallOutput | typeof UNAUTHORIZED | typeof RATE_LIMITED> {
  let res;
  try {
    res = await mcp.client.callTool({
      name,
      arguments: { ...args, session_id: mcp.sessionId, agent_id: mcp.agentId, context },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return UNAUTHORIZED;
    throw err;
  }
  const content = (res.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  const images = content
    .filter((c) => c.type === "image" && c.data)
    .map((c) => ({ data: c.data!, mimeType: c.mimeType ?? "image/png" }));
  const parts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  const notice = parts.findIndex((p) => p.startsWith("[session_id issued"));
  if (notice >= 0) {
    const issued = parts[notice].match(/session_id: (ses_[0-9A-Za-z]{27})/);
    if (issued) mcp.sessionId = issued[1];
    parts.splice(notice, 1);
  }
  const text = parts.join("");
  const status = errorStatus(text, Boolean(res.isError));
  if (status === 401) return UNAUTHORIZED;
  if (status === 429) return RATE_LIMITED;
  if (res.isError) throw new Error(`${name}: ${text}`);
  return { text, images };
}

// 401 or 429 from a failed call. Data API failures come back inside a successful result, e.g.
// {error: {status: 401, code: "not_authorized"}} or {error: {message: "GET /v2/pages returned 429"}}.
// A 401 counts only when it is a structured status or code: a message that merely mentions "401" must not
// set off a new login. A rate limit may be matched in the message, since a wrong match only costs a retry.
export function errorStatus(text: string, isError: boolean): 401 | 429 | undefined {
  let error: { status?: number; code?: string; message?: string } | undefined;
  if (isError) error = { message: text };
  else {
    try {
      error = (JSON.parse(text) as { error?: typeof error }).error;
    } catch {
      return;
    }
  }
  if (!error) return;
  const detail = `${error.code ?? ""} ${error.message ?? ""}`;
  if (error.status === 401 || error.code === "not_authorized") return 401;
  if (error.status === 429 || /\b429\b|too_many_requests|rate limit/i.test(detail)) return 429;
}

// Call an action-style tool and return the parsed action result.
export async function call<T = unknown>(
  mcp: WebflowMcp,
  name: string,
  args: Record<string, unknown>,
  context = mcp.context,
): Promise<ActionResult<T>> {
  return JSON.parse(await callText(mcp, name, args, context)) as ActionResult<T>;
}

// Like call(), but throws when the action reports an error instead of returning it.
export async function run<T = unknown>(
  mcp: WebflowMcp,
  name: string,
  args: Record<string, unknown>,
  context?: string,
): Promise<T> {
  const r = await call<T>(mcp, name, args, context);
  if (r.error) throw new Error(`${name} > ${r.action}: ${r.error.message}`);
  return r.result as T;
}
