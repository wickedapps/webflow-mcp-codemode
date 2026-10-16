import { expect, spyOn, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { callOutput, errorStatus, type WebflowMcp } from "./client.ts";
import { RateGate, limiter } from "./limits.ts";

const result = (error: unknown) => JSON.stringify({ label: "x", action: "get_page", error });

test("a structured 401 means the login was rejected", () => {
  expect(errorStatus(result({ status: 401, message: "Unauthorized" }), false)).toBe(401);
  expect(errorStatus(result({ code: "not_authorized", message: "Request not authorized" }), false)).toBe(401);
});

test("a message that only mentions 401 does not", () => {
  expect(errorStatus(result({ status: 404, message: "Room 401 not found" }), false)).toBeUndefined();
  expect(errorStatus("Error: item 401 is missing", true)).toBeUndefined();
});

test("rate limits are matched by status or message", () => {
  expect(errorStatus(result({ status: 429 }), false)).toBe(429);
  expect(errorStatus(result({ message: "GET /v2/pages returned 429" }), false)).toBe(429);
  expect(errorStatus("Too many requests: rate limit exceeded", true)).toBe(429);
});

test("successful results and plain text are left alone", () => {
  expect(errorStatus(JSON.stringify({ label: "x", action: "list_sites", result: { sites: [] } }), false)).toBeUndefined();
  expect(errorStatus("not json", false)).toBeUndefined();
});

// A connection whose server answers 429 to the first `limits` calls, and logs when each call arrives.
function fakeMcp(limits: number) {
  const arrivals: number[] = [];
  const start = Date.now();
  let left = limits;
  const client = {
    callTool: async () => {
      arrivals.push(Date.now() - start);
      await Bun.sleep(5);
      const text = left-- > 0 ? JSON.stringify({ error: { status: 429 } }) : JSON.stringify({ label: "x", action: "a", result: {} });
      return { content: [{ type: "text", text }] };
    },
  };
  const mcp = { client, agentId: "a", sessionId: "s", context: "c", authStage: 0, recover: async () => {}, recovering: () => undefined };
  return { mcp: { ...mcp, rateGate: new RateGate({ delays: [0.1, 0.2], random: () => 0 }) } as unknown as WebflowMcp, arrivals };
}

test("a 429 pauses the other calls too, and is logged once", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { mcp, arrivals } = fakeMcp(1);
    const first = callOutput(mcp, "tool.a", {});
    await Bun.sleep(20);
    // Sent after the first call's 429: waits out the pause before going out.
    const second = callOutput(mcp, "tool.b", {});
    await Promise.all([first, second]);
    expect(arrivals.length).toBe(3);
    expect(Math.min(...arrivals.slice(1))).toBeGreaterThanOrEqual(95);
    expect(mcp.rateGate.hits).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

test("a write that is limited isn't retried, but still pauses the calls behind it", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { mcp } = fakeMcp(1);
    await expect(callOutput(mcp, "tool.write", {}, "c", { resend: false })).rejects.toThrow("not retried");
    expect(await Promise.race([mcp.rateGate.open().then(() => "open"), Bun.sleep(20).then(() => "paused")])).toBe("paused");
  } finally {
    log.mockRestore();
  }
});

test("a call still waiting out a pause when the run stops is never sent", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { mcp, arrivals } = fakeMcp(1);
    await expect(callOutput(mcp, "tool.write", {}, "c", { resend: false })).rejects.toThrow();
    const stop = new AbortController();
    const waiting = callOutput(mcp, "tool.write", {}, "c", { resend: false, signal: stop.signal });
    stop.abort();
    await expect(waiting).rejects.toThrow("not sent");
    await Bun.sleep(150);
    expect(arrivals.length).toBe(1);
  } finally {
    log.mockRestore();
  }
});

test("a call isn't sent if the run stops just as the pause ends", async () => {
  const { mcp, arrivals } = fakeMcp(0);
  const stop = new AbortController();
  const call = callOutput(mcp, "tool.write", {}, "c", { resend: false, signal: stop.signal });
  stop.abort();
  await expect(call).rejects.toThrow("not sent");
  expect(arrivals.length).toBe(0);
});

test("retries take a slot again, so a concurrency limit lowered by a 429 applies to them", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    let inFlight = 0;
    let peakAfterPause = 0;
    let limitedLeft = 8;
    const client = {
      callTool: async () => {
        inFlight++;
        if (limitedLeft < 8) peakAfterPause = Math.max(peakAfterPause, inFlight);
        await Bun.sleep(10);
        inFlight--;
        const text = limitedLeft-- > 0 ? JSON.stringify({ error: { status: 429 } }) : JSON.stringify({ result: {} });
        return { content: [{ type: "text", text }] };
      },
    };
    const gate = new RateGate({ delays: [0.03], concurrency: 4, random: () => 0 });
    const mcp = { client, agentId: "a", sessionId: "s", context: "c", authStage: 0, recover: async () => {}, recovering: () => undefined, rateGate: gate };
    const admit = limiter(() => gate.concurrency());
    const calls = Array.from({ length: 4 }, (_, i) => callOutput(mcp as unknown as WebflowMcp, `tool.${i}`, {}, "c", { admit }));
    await Promise.all(calls);
    expect(gate.concurrency()).toBeLessThan(4);
    // The first four went out together; after the first 429 halved the limit, no more than two were out at once.
    expect(peakAfterPause).toBeLessThanOrEqual(2);
  } finally {
    log.mockRestore();
  }
});

// A connection whose server answers 401 in the tool's result (`rejected`) or at the MCP login (`unauthorized`) to the
// first call, then succeeds. Recovery takes 30ms and swaps in a new client, as the real one does.
function recoveringMcp(first: "rejected" | "unauthorized") {
  const sent: string[] = [];
  let answered = 0;
  let pending: Promise<void> | undefined;
  const makeClient = (live: { open: boolean }) => ({
    callTool: async ({ name }: { name: string }) => {
      if (!live.open) throw new Error("Not connected");
      sent.push(name);
      await Bun.sleep(5);
      if (answered++ === 0) {
        if (first === "unauthorized") throw new UnauthorizedError("401");
        return { content: [{ type: "text", text: JSON.stringify({ error: { status: 401 } }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ result: {} }) }] };
    },
  });
  let live = { open: true };
  const mcp = {
    client: makeClient(live),
    agentId: "a",
    sessionId: "s",
    context: "c",
    authStage: 0,
    rateGate: new RateGate(),
    recovering: () => pending,
    recover(seen: number) {
      if (seen !== mcp.authStage) return pending ?? Promise.resolve();
      live.open = false;
      pending = Bun.sleep(30).then(() => {
        live = { open: true };
        mcp.client = makeClient(live);
        mcp.authStage++;
        pending = undefined;
      });
      return pending;
    },
  };
  return { mcp: mcp as unknown as WebflowMcp, sent };
}

test("queued calls wait for a login recovery instead of going out on the closed connection", async () => {
  const { mcp, sent } = recoveringMcp("rejected");
  const admit = limiter(1);
  const calls = ["tool.a", "tool.b", "tool.c"].map((n) => callOutput(mcp, n, {}, "c", { admit }));
  // On the closed connection, b or c would throw "Not connected". They wait instead, and a's retry goes first.
  await Promise.all(calls);
  expect(sent).toEqual(["tool.a", "tool.a", "tool.b", "tool.c"]);
});

test("a write isn't sent again after a 401 in its result, but is after the MCP login rejected it", async () => {
  const rejected = recoveringMcp("rejected");
  await expect(callOutput(rejected.mcp, "tool.write", {}, "c", { resend: false })).rejects.toThrow("may have partly run");
  expect(rejected.sent).toEqual(["tool.write"]);
  const unauthorized = recoveringMcp("unauthorized");
  await callOutput(unauthorized.mcp, "tool.write", {}, "c", { resend: false });
  expect(unauthorized.sent).toEqual(["tool.write", "tool.write"]);
});

test("a 429 starts the pause before its slot goes to the next queued call", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { mcp, arrivals } = fakeMcp(1);
    const admit = limiter(1);
    await Promise.all([callOutput(mcp, "tool.a", {}, "c", { admit }), callOutput(mcp, "tool.b", {}, "c", { admit })]);
    // tool.a is limited at about 5ms; tool.b, queued behind it, goes out only after the 100ms pause.
    expect(arrivals.length).toBe(3);
    expect(arrivals[1]).toBeGreaterThanOrEqual(95);
  } finally {
    log.mockRestore();
  }
});

// A connection with no session yet. Each call records the session ID it was sent with; a call that `fails` throws
// before the server answers, and the first call that gets through has an ID issued.
function sessionMcp(fails: Set<string>) {
  const sentWith: Array<[string, string]> = [];
  const mcp = {
    agentId: "a",
    sessionId: "start",
    context: "c",
    authStage: 0,
    rateGate: new RateGate(),
    recover: async () => {},
    recovering: () => undefined,
    client: {
      callTool: async ({ name, arguments: a }: { name: string; arguments: { session_id: string } }) => {
        sentWith.push([name, a.session_id]);
        await Bun.sleep(5);
        if (fails.has(name)) throw new Error("network");
        const issued = a.session_id === "start" ? [{ type: "text", text: `[session_id issued] session_id: ses_${"a".repeat(27)}` }] : [];
        return { content: [...issued, { type: "text", text: JSON.stringify({ result: {} }) }] };
      },
    },
  };
  return { mcp: mcp as unknown as WebflowMcp, sentWith };
}

test("calls go out one at a time until one gets a session ID, even when the first fails", async () => {
  const { mcp, sentWith } = sessionMcp(new Set(["tool.a"]));
  const results = await Promise.allSettled(["tool.a", "tool.b", "tool.c", "tool.d"].map((n) => callOutput(mcp, n, {})));
  expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled"]);
  const issued = `ses_${"a".repeat(27)}`;
  expect(sentWith).toEqual([
    ["tool.a", "start"],
    ["tool.b", "start"],
    ["tool.c", issued],
    ["tool.d", issued],
  ]);
});
