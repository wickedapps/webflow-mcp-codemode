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

// Run at most `max` tasks at once; the rest wait in order. A finished task hands its slot straight to the
// next waiter, so a newcomer can't slip in between and exceed the limit.
export function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
