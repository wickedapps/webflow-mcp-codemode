import { expect, test } from "bun:test";
import { limiter, truncateMiddle } from "./limits.ts";

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
