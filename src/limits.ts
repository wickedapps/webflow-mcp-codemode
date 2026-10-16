// Small helpers run.ts uses to bound a run: how much output comes back and how many calls run at once.

// Shorten text to about `max` characters, keeping the start and the end, where errors and summaries
// usually are. `note` explains the cut and is placed where the text was removed.
// Both cuts move to a line break when there is one in the last or first fifth of the kept part.
export function truncateMiddle(text: string, max: number, note: (omitted: number) => string): string {
  if (text.length <= max) return text;
  let head = Math.floor(max * 0.75);
  let tail = text.length - (max - head);
  const lineEnd = text.lastIndexOf("\n", head);
  if (lineEnd > head * 0.8) head = lineEnd;
  const lineStart = text.indexOf("\n", tail);
  if (lineStart >= 0 && lineStart - tail < (text.length - tail) * 0.2) tail = lineStart + 1;
  return `${text.slice(0, head)}\n${note(tail - head)}\n${text.slice(tail)}`;
}

// Run at most `max()` tasks at once; the rest wait in order. A finished task hands its slot straight to the
// next waiter, so a newcomer can't slip in between and exceed the limit. When the limit drops, finished tasks
// give up their slots until the running ones fit; when it rises, waiters start at once.
export function limiter(max: number | (() => number)) {
  const cap = typeof max === "number" ? () => max : max;
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < cap()) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = active <= cap() ? waiting.shift() : undefined;
      if (next) next();
      else active--;
      while (active < cap()) {
        const more = waiting.shift();
        if (!more) break;
        active++;
        more();
      }
    }
  };
}

// Output above this many characters gets a note: everything a snippet prints comes back into the conversation.
export const LONG_OUTPUT = 6000;

// The note for a run that printed a lot, or undefined. Full lists belong in out/, with a summary printed.
export function longOutputNote(output: string): string | undefined {
  if (output.length <= LONG_OUTPUT) return undefined;
  const lines = output.split("\n").filter(Boolean).length;
  return (
    `[wf-mcp] This run printed ${output.length.toLocaleString("en-US")} characters (${lines} lines), and everything printed comes back ` +
    "into the conversation. Print counts and a few examples instead, and write full lists with out.write()."
  );
}

// One pause shared by every call in a run while Webflow rate limits it (429). Calls backing off on their own wake
// together and hit the limit again; with the pause, no call goes out until it ends. Each call takes a ticket (the
// pause count) as it goes out. A 429 on a call sent since the last pause began starts a longer one (2, 4, 8, 16,
// then 32 seconds); a 429 on a call sent before it is covered by it. A call that gets through sets the length back
// to the first. Each new pause also halves how many calls may run at once (never below one), and every 10 calls
// that get through add one back, up to `concurrency`.
// Which pause a call went out after. An object, so it can't be mixed up with the timestamps it replaced.
export interface Ticket {
  readonly generation: number;
}

export class RateGate {
  // 429s seen.
  hits = 0;
  private generation = 0;
  private until = 0;
  private streak = 0;
  // Each pause's start and end, a pause that lengthens a running one extending it.
  private readonly pauses: Array<{ start: number; end: number }> = [];
  private passes = 0;
  private allowed: number;
  private readonly max: number;
  private readonly delays: number[];
  private readonly now: () => number;
  private readonly random: () => number;

  constructor({ delays = [2, 4, 8, 16, 32], concurrency = Infinity, now = Date.now, random = Math.random } = {}) {
    this.delays = delays;
    this.max = this.allowed = concurrency;
    this.now = now;
    this.random = random;
  }

  // Wait out any pause, checking again on waking in case it grew meanwhile. Resolves false, without waiting
  // further, once `signal` aborts: a call still waiting when its run stops must not be sent.
  async open(signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;
      const left = this.until - this.now();
      if (left <= 0) return true;
      // Calls resume up to a second apart, so they don't all go out at once.
      await sleep(left + Math.floor(this.random() * 1000), signal);
    }
  }

  // Whether calls may go out now.
  isOpen(): boolean {
    return this.until <= this.now();
  }

  // Taken just before a call goes out, and passed to limited() or passed() when it comes back.
  ticket(): Ticket {
    return { generation: this.generation };
  }

  // A call got a 429. Returns the seconds left in the pause, and whether this 429 started it.
  limited(ticket: Ticket): { seconds: number; started: boolean } {
    this.hits++;
    const now = this.now();
    if (ticket.generation !== this.generation) return { seconds: Math.max(0, this.until - now) / 1000, started: false };
    this.generation++;
    const delay = this.delays[Math.min(this.streak++, this.delays.length - 1)] ?? 0;
    const until = now + delay * 1000;
    if (until > this.until) {
      const last = this.pauses.at(-1);
      if (last && now < last.end) last.end = until;
      else this.pauses.push({ start: now, end: until });
      this.until = until;
    }
    this.allowed = Math.max(1, Math.floor(this.allowed / 2));
    this.passes = 0;
    return { seconds: delay, started: true };
  }

  // A call got through. One sent before the last pause began says nothing about the limit now.
  passed(ticket: Ticket): void {
    if (ticket.generation !== this.generation) return;
    this.streak = 0;
    if (++this.passes >= 10 && this.allowed < this.max) {
      this.allowed++;
      this.passes = 0;
    }
  }

  // How many calls may run at once now.
  concurrency(): number {
    return this.allowed;
  }

  // Milliseconds rate-limit pauses had lasted by `at`, overlapping pauses counted once.
  cooldownMs(at = this.now()): number {
    return this.pauses.reduce((sum, p) => sum + Math.max(0, Math.min(p.end, at) - p.start), 0);
  }
}

// Resolves after `ms`, or as soon as `signal` aborts.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
