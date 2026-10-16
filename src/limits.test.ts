import { expect, test } from "bun:test";
import { RateGate, limiter, longOutputNote, truncateMiddle } from "./limits.ts";

test("truncateMiddle keeps the start and the end", () => {
  const text = "a".repeat(100) + "END";
  const out = truncateMiddle(text, 20, (n) => `[${n} cut]`);
  expect(out.startsWith("a".repeat(15))).toBe(true);
  expect(out.endsWith("aaEND")).toBe(true);
  expect(out).toContain("[83 cut]");
  expect(truncateMiddle("short", 20, () => "x")).toBe("short");
});

test("truncateMiddle cuts at line breaks", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, "0")}`).join("\n");
  const out = truncateMiddle(text, 100, () => "[cut]").split("\n");
  expect(out.every((l) => l === "[cut]" || /^line \d\d$/.test(l))).toBe(true);
  expect(out.at(-1)).toBe("line 49");
});

test("limiter never runs more than max tasks at once", async () => {
  const limit = limiter(3);
  let running = 0;
  let peak = 0;
  const task = async (ms: number) => {
    peak = Math.max(peak, ++running);
    await Bun.sleep(ms);
    running--;
    return ms;
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => limit(() => task(1 + (i % 4)))));
  expect(peak).toBe(3);
  expect(results).toHaveLength(12);
});

test("limiter frees the slot when a task throws", async () => {
  const limit = limiter(1);
  await expect(limit(async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
  expect(await limit(async () => "next")).toBe("next");
});

test("longOutputNote flags runs that print a lot", () => {
  expect(longOutputNote("short\n")).toBeUndefined();
  const rows = Array.from({ length: 300 }, (_, i) => `item ${i}\tsome-slug-${i}\tpublished`).join("\n");
  expect(longOutputNote(rows)).toContain("(300 lines)");
  expect(longOutputNote(rows)).toContain("out.write()");
});

test("limiter follows a limit that changes", async () => {
  let max = 4;
  const limit = limiter(() => max);
  let running = 0;
  const peaks: number[] = [];
  const task = async () => {
    peaks.push(++running);
    await Bun.sleep(5);
    running--;
  };
  const first = Array.from({ length: 4 }, () => limit(task));
  max = 1;
  const rest = Array.from({ length: 6 }, () => limit(task));
  await Promise.all([...first, ...rest]);
  // Once the first four finish, no more than one runs at a time.
  expect(peaks.slice(4).every((p) => p === 1)).toBe(true);
  max = 3;
  running = 0;
  peaks.length = 0;
  await Promise.all(Array.from({ length: 9 }, () => limit(task)));
  expect(Math.max(...peaks)).toBe(3);
});

// A gate on a clock the test moves by hand, with no jitter.
function gate(concurrency = Infinity) {
  let t = 0;
  const g = new RateGate({ concurrency, now: () => t, random: () => 0 });
  return { g, at: (ms: number) => (t = ms) };
}

test("RateGate: 429s from calls already in flight don't lengthen the pause, even in the same millisecond", () => {
  const { g, at } = gate();
  const [first, second, third] = [g.ticket(), g.ticket(), g.ticket()] as const;
  at(100);
  expect(g.limited(first)).toEqual({ seconds: 2, started: true });
  // Same millisecond, and later: both were sent before the pause began.
  expect(g.limited(second).started).toBe(false);
  at(150);
  expect(g.limited(third)).toEqual({ seconds: 1.95, started: false });
  expect(g.hits).toBe(3);
  at(2100);
  expect(g.cooldownMs()).toBe(2000);
});

test("RateGate lengthens the pause while retries keep being limited, and resets once a call gets through", () => {
  const { g, at } = gate();
  const seconds: number[] = [];
  let t = 0;
  for (let i = 0; i < 7; i++) {
    at(t);
    const { seconds: s } = g.limited(g.ticket());
    seconds.push(s);
    t += s * 1000 + 10;
  }
  expect(seconds).toEqual([2, 4, 8, 16, 32, 32, 32]);
  at(t);
  g.passed(g.ticket());
  expect(g.limited(g.ticket()).seconds).toBe(2);
});

test("RateGate ignores a success from a call sent before the pause began", () => {
  const { g, at } = gate();
  const early = g.ticket();
  at(100);
  g.limited(g.ticket());
  at(2200);
  g.limited(g.ticket());
  g.passed(early);
  at(6300);
  expect(g.limited(g.ticket()).seconds).toBe(8);
});

test("RateGate counts pause time, not gaps between pauses, up to the time asked about", () => {
  const { g, at } = gate();
  g.limited(g.ticket());
  at(1000);
  expect(g.cooldownMs()).toBe(1000);
  at(2500);
  g.limited(g.ticket());
  expect(g.cooldownMs(3000)).toBe(2500);
  at(9000);
  expect(g.cooldownMs()).toBe(6000);
});

test("RateGate halves concurrency on each pause and adds one back per 10 calls that get through", () => {
  const { g, at } = gate(8);
  expect(g.concurrency()).toBe(8);
  g.limited(g.ticket());
  expect(g.concurrency()).toBe(4);
  at(3000);
  g.limited(g.ticket());
  g.limited(g.ticket());
  expect(g.concurrency()).toBe(1);
  for (let i = 0; i < 20; i++) g.passed(g.ticket());
  expect(g.concurrency()).toBe(3);
  for (let i = 0; i < 100; i++) g.passed(g.ticket());
  expect(g.concurrency()).toBe(8);
});

test("RateGate.open waits out a pause that grows while it sleeps", async () => {
  const g = new RateGate({ delays: [0.05, 0.15], random: () => 0 });
  const start = Date.now();
  g.limited(g.ticket());
  const waiting = g.open();
  await Bun.sleep(30);
  // Another call's retry is limited during the first pause, lengthening it.
  g.limited(g.ticket());
  expect(await waiting).toBe(true);
  expect(Date.now() - start).toBeGreaterThanOrEqual(175);
});

test("RateGate.open gives up as soon as the run stops", async () => {
  const g = new RateGate({ delays: [10], random: () => 0 });
  g.limited(g.ticket());
  const stop = new AbortController();
  const start = Date.now();
  const waiting = g.open(stop.signal);
  setTimeout(() => stop.abort(), 20);
  expect(await waiting).toBe(false);
  expect(Date.now() - start).toBeLessThan(1000);
  expect(await g.open(stop.signal)).toBe(false);
});

test("RateGate.cooldownMs at a past time isn't changed by later pauses", () => {
  const { g, at } = gate();
  g.limited(g.ticket());
  at(5000);
  g.limited(g.ticket());
  expect(g.cooldownMs(3000)).toBe(2000);
  expect(g.cooldownMs(6000)).toBe(3000);
});
