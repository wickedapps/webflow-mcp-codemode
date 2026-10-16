// The structure of what each action returned in earlier runs. Webflow's tools publish input schemas but no output
// schemas, so a snippet's result type is a guess (`list_sites<{ sites: Site[] }>()`), and a wrong guess still
// typechecks: the snippet reads undefined and carries on. The runner records each action's results here: key names
// and value types, never values, from the action's last RUNS runs in this home. `wf-mcp types <tool>.<action>`
// prints the shape under the action's signature (type-docs.ts).
//
// Key names can be data too (an object keyed by IDs, emails or page paths), so an object whose keys look like data
// is recorded as a map, with no keys kept. CMS items' fieldData is always a map: its keys are the collection's field
// slugs, which differ between collections and come from get_collection_details. Sensitive actions aren't recorded
// at all (run.ts).
import fs from "node:fs";
import { SHAPES_FILE } from "./paths.ts";

const PRIMS = ["string", "number", "boolean", "null", "unknown"] as const;
export type Prim = (typeof PRIMS)[number];

// One value's structure, merged over every value seen in that place. A value can take several forms (`string | null`).
export interface Shape {
  prims?: Prim[];
  // n: objects seen here. Each key counts the objects that had it, so a key some of them lacked is optional.
  object?: { n: number; keys: Record<string, { n: number; shape: Shape }> };
  // An object keyed by data rather than fixed field names: the shape of its values.
  map?: Shape;
  // The elements' shape, or null when every array seen here was empty.
  array?: Shape | null;
}

// Deeper than this is recorded as unknown. Long arrays and maps are sampled, and an object stops taking new keys
// past MAX_KEYS.
const MAX_DEPTH = 8;
const SAMPLE = 50;
const MAX_KEYS = 200;
// Keys that are IDs (Webflow's 24-hex, numeric, UUIDs), or that look like data rather than field names: anything
// with an @, a slash or whitespace in it, or longer than a field name would be.
const ID_KEY = /^(?:[0-9a-f]{24}|\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const dataKey = (k: string) => ID_KEY.test(k) || /[@/\s]/.test(k) || k.length > 64;
const MAP_KEYS = new Set(["fieldData"]);

// Key tables are built with Object.fromEntries and read with Object.entries, which treat keys such as
// "constructor" or "__proto__" as plain own keys; merging goes through a Map for the same reason.
type Field = { n: number; shape: Shape };

export function shapeOf(value: unknown, depth = 0, asMap = false): Shape {
  if (value === null) return { prims: ["null"] };
  if (typeof value === "string") return { prims: ["string"] };
  if (typeof value === "number") return { prims: ["number"] };
  if (typeof value === "boolean") return { prims: ["boolean"] };
  if (depth >= MAX_DEPTH || typeof value !== "object") return { prims: ["unknown"] };
  if (Array.isArray(value)) {
    if (!value.length) return { array: null };
    return { array: value.slice(0, SAMPLE).reduce<Shape | undefined>((s, v) => merge(s, shapeOf(v, depth + 1)), undefined) ?? null };
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (asMap || (entries.length && entries.some(([k]) => dataKey(k)))) {
    return { map: entries.slice(0, SAMPLE).reduce<Shape>((s, [, v]) => merge(s, shapeOf(v, depth + 1)), {}) };
  }
  const keys = entries.slice(0, MAX_KEYS).map(([k, v]): [string, Field] => [k, { n: 1, shape: shapeOf(v, depth + 1, MAP_KEYS.has(k)) }]);
  return { object: { n: 1, keys: Object.fromEntries(keys) } };
}

export function merge(a: Shape | undefined, b: Shape): Shape {
  if (!a) return b;
  const out: Shape = {};
  const prims = [...new Set([...(a.prims ?? []), ...(b.prims ?? [])])].sort();
  if (prims.length) out.prims = prims;
  if (a.map || b.map) out.map = a.map && b.map ? merge(a.map, b.map) : (a.map ?? b.map);
  if (a.object || b.object) {
    const keys = new Map(Object.entries(a.object?.keys ?? {}));
    for (const [k, v] of Object.entries(b.object?.keys ?? {})) {
      const had = keys.get(k);
      if (had) keys.set(k, { n: had.n + v.n, shape: merge(had.shape, v.shape) });
      else if (keys.size < MAX_KEYS) keys.set(k, v);
    }
    // An empty object seen where maps are is an empty map, not a second form.
    if (!(out.map && !keys.size)) out.object = { n: (a.object?.n ?? 0) + (b.object?.n ?? 0), keys: Object.fromEntries(keys) };
  }
  if (a.array !== undefined || b.array !== undefined) {
    out.array = a.array && b.array ? merge(a.array, b.array) : (a.array ?? b.array ?? null);
  }
  return out;
}

const WIDTH = 100;
const SHOWN_KEYS = 40;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const keyName = (k: string) => (IDENTIFIER.test(k) ? k : JSON.stringify(k));

// The shape as a TypeScript type, on one line when it fits and indented over several when it doesn't. `indent` is
// the indent of the line the type starts on and `column` where on it the type starts; below `depth` levels, types
// show as unknown.
export function render(
  shape: Shape,
  { indent = "", column = indent.length, depth = Infinity }: { indent?: string; column?: number; depth?: number } = {},
): string {
  const flat = forms(shape, indent, true, depth).join(" | ") || "unknown";
  if (column + flat.length <= WIDTH) return flat;
  return forms(shape, indent, false, depth).join(" | ") || "unknown";
}

function part(shape: Shape, indent: string, flat: boolean, column: number, depth: number): string {
  if (depth <= 0) return "unknown";
  return flat ? forms(shape, indent, true, depth).join(" | ") || "unknown" : render(shape, { indent, column, depth });
}

function forms(shape: Shape, indent: string, flat: boolean, depth: number): string[] {
  const out: string[] = [];
  if (shape.object) out.push(objectType(shape.object, indent, flat, depth));
  if (shape.map) out.push(`Record<string, ${part(shape.map, indent, flat, indent.length + 15, depth - 1)}>`);
  if (shape.array === null) out.push("unknown[] /* only empty arrays seen */");
  else if (shape.array) out.push(`Array<${part(shape.array, indent, flat, indent.length + 6, depth - 1)}>`);
  out.push(...(shape.prims ?? []));
  return out;
}

function objectType(object: NonNullable<Shape["object"]>, indent: string, flat: boolean, depth: number): string {
  const entries = Object.entries(object.keys);
  if (!entries.length) return "{}";
  const shown = entries.slice(0, SHOWN_KEYS);
  const note = entries.length > shown.length ? ` /* ${entries.length - shown.length} more keys */` : "";
  const inner = `${indent}  `;
  const fields = shown.map(([k, v]) => {
    const name = `${keyName(k)}${v.n < object.n ? "?" : ""}: `;
    return `${name}${part(v.shape, inner, flat, inner.length + name.length, depth - 1)}`;
  });
  if (flat) return `{ ${fields.join("; ")}${note} }`;
  return `{\n${fields.map((f) => `${inner}${f};`).join("\n")}${note && `\n${inner}${note.trim()}`}\n${indent}}`;
}

// shapes.json: per `tool.action`, the shape from each of its last RUNS runs (one merged shape per run), newest
// first, so keys an action stopped returning drop out after a while. An entry always has at least one run.
export const RUNS = 5;
export interface Run {
  day: string;
  shape: Shape;
}
export interface ShapeEntry {
  runs: [Run, ...Run[]];
}
export type ShapeStore = Map<string, ShapeEntry>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrim = (v: unknown): v is Prim => PRIMS.some((p) => p === v);

// Whether `v` is a Shape this module wrote. The file is only ever written here, but a bad one mustn't break
// `wf-mcp types`, so each entry is checked and a bad one dropped.
function isShape(v: unknown, depth = 0): v is Shape {
  if (!isRecord(v) || depth > MAX_DEPTH + 2) return false;
  const { prims, map, array, object } = v;
  if (prims !== undefined && !(Array.isArray(prims) && prims.every(isPrim))) return false;
  if (map !== undefined && !isShape(map, depth + 1)) return false;
  if (array !== undefined && array !== null && !isShape(array, depth + 1)) return false;
  if (object === undefined) return true;
  return (
    isRecord(object) &&
    typeof object.n === "number" &&
    isRecord(object.keys) &&
    Object.values(object.keys).every((f) => isRecord(f) && typeof f.n === "number" && isShape(f.shape, depth + 1))
  );
}

const isRun = (v: unknown): v is Run => isRecord(v) && typeof v.day === "string" && isShape(v.shape);
const isEntry = (v: unknown): v is ShapeEntry => isRecord(v) && Array.isArray(v.runs) && v.runs.length > 0 && v.runs.every(isRun);

export function loadShapes(file = SHAPES_FILE): ShapeStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
  if (!isRecord(parsed)) return new Map();
  return new Map(Object.entries(parsed).filter((e): e is [string, ShapeEntry] => isEntry(e[1])));
}

// Two runs saving at once would each read the file, add their own shapes and overwrite the other's, so the
// read-merge-write holds a lock (a directory, created atomically), waiting up to a second for another run's.
// A lock left by a crashed run is reported rather than taken over: two runs taking over the same old lock can each
// delete the lock the other just made.
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
      if (Date.now() > deadline) {
        throw new Error(`${lock} exists: another run is saving, or one stopped while saving. Delete it if no wf-mcp run is going.`);
      }
      Bun.sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// Add a run's shapes to the file. Returns the actions it had no shape for before.
export function saveShapes(
  seen: Map<string, Shape>,
  { file = SHAPES_FILE, today = new Date().toISOString().slice(0, 10) }: { file?: string; today?: string } = {},
): string[] {
  if (!seen.size) return [];
  return withLock(file, () => {
    const store = loadShapes(file);
    const added: string[] = [];
    for (const [name, shape] of seen) {
      const had = store.get(name);
      if (!had) added.push(name);
      store.set(name, { runs: [{ day: today, shape }, ...(had?.runs ?? []).slice(0, RUNS - 1)] });
    }
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)) + "\n");
    fs.renameSync(tmp, file);
    return added;
  });
}

// A note longer than this shows fewer levels, so one action's docs stay a few thousand characters.
const MAX_NOTE = 6000;

// What `wf-mcp types` prints under an action's signature, or undefined when no run has called it yet.
export function shapeNote(name: string, store = loadShapes()): string | undefined {
  const entry = store.get(name);
  if (!entry) return;
  const [latest, ...older] = entry.runs;
  const shape = older.reduce((s, r) => merge(s, r.shape), latest.shape);
  let depth = Infinity;
  let type = render(shape, { indent: "  ", column: 16 });
  for (let d = 6; type.length > MAX_NOTE && d > 0; d--) type = render(shape, { indent: "  ", column: 16, depth: (depth = d) });
  const first = (older.at(-1) ?? latest).day;
  const runs = entry.runs.length === 1 ? "one run" : `the last ${entry.runs.length} runs`;
  return [
    `  // What it returned in ${runs} (${first === latest.day ? first : `${first} to ${latest.day}`}): key names and types, merged over`,
    "  // every call. Webflow publishes no output schema, so this is what was seen, not a contract: `?` keys were",
    `  // missing from some results.${depth < Infinity ? ` Levels below ${depth} are shown as unknown.` : ""}`,
    `  type Result = ${type};`,
  ].join("\n");
}
