/**
 * `swrag meeting config …` command surface (v0.8.0).
 *
 * Pure (DB-bound, but otherwise side-effect-light) helpers backing
 * the CLI. The CLI module in `src/cli.ts` adapts citty positional /
 * flag input into these functions, then optionally fires
 * `{op:"config_reload"}` on the daemon socket so the running watcher
 * picks up the change without a restart.
 *
 * Design notes worth knowing:
 *
 *   - Every mutation goes through `writeConfig` so the zod schema +
 *     URL-regex validation run on the post-mutation value. We never
 *     persist a config the schema would reject.
 *   - The "list" mutations (allow-app, block-url, etc.) are
 *     idempotent on adds (no duplicates) and lenient on removes (no
 *     error when the entry isn't present — useful in scripts).
 *   - `set <dotted.path> <value>` coerces strings to booleans /
 *     numbers heuristically: `"true"`, `"false"` → boolean;
 *     integer-shaped strings → number; everything else stays a
 *     string. For array-valued paths, the value REPLACES the array
 *     wholesale; we wrap a single value as `[value]`, or accept a
 *     JSON-literal array (`"[]"` clears).
 *   - `schedule add` parses three day shapes — single (`"mon"`),
 *     range (`"mon-fri"`), or comma-separated list
 *     (`"mon,wed,fri"`) — and a `HH:MM-HH:MM` time range. The
 *     resulting window is appended to `schedule.windows`; the
 *     `schedule add` form intentionally does not flip
 *     `schedule.enabled` on its own. The user runs
 *     `schedule enable` once they have the windows they want.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { openArchive } from "../archive/open.ts";
import {
  DayOfWeekSchema,
  type DayOfWeek,
  PopupConfigSchema,
  type PopupConfig,
  type ScheduleWindow,
  defaultConfig,
  readConfig,
  resetConfig,
  writeConfig,
} from "../meeting/config.ts";
import { deleteFailedRows } from "../meeting/queue.ts";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function withDb<T>(archive: string, fn: (db: Database) => T): T {
  const db = openArchive(archive, {});
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Print-form of the config, matching what `get` would emit. */
export function formatConfig(c: PopupConfig): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* Get / reset                                                                */
/* -------------------------------------------------------------------------- */

export function cmdGet(archive: string): PopupConfig {
  return withDb(archive, (db) => readConfig(db));
}

export function cmdReset(archive: string): PopupConfig {
  return withDb(archive, (db) => resetConfig(db));
}

/* -------------------------------------------------------------------------- */
/* Allow / block lists                                                        */
/* -------------------------------------------------------------------------- */

type ListKind = "allow-app" | "unallow-app" | "block-app" | "unblock-app" |
  "allow-url" | "unallow-url" | "block-url" | "unblock-url";

/**
 * Append (or remove) a single value on one of the four match-list
 * arrays. Returns the post-mutation config so callers can echo it
 * or feed it to a serialiser.
 *
 * Idempotent on adds (no duplicates), lenient on removes (no error
 * when the value isn't present — keeps scripts simple).
 */
export function cmdListOp(archive: string, kind: ListKind, value: string): PopupConfig {
  return withDb(archive, (db) => {
    const c = readConfig(db);
    const arr = pickListArray(c, kind);
    if (kind.startsWith("unallow") || kind.startsWith("unblock")) {
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1);
    } else {
      if (!arr.includes(value)) arr.push(value);
    }
    return writeConfig(db, c);
  });
}

function pickListArray(c: PopupConfig, kind: ListKind): string[] {
  switch (kind) {
    case "allow-app":
    case "unallow-app":
      return c.allowlist.bundle_ids;
    case "block-app":
    case "unblock-app":
      return c.blocklist.bundle_ids;
    case "allow-url":
    case "unallow-url":
      return c.allowlist.url_patterns;
    case "block-url":
    case "unblock-url":
      return c.blocklist.url_patterns;
  }
}

/* -------------------------------------------------------------------------- */
/* set <dotted.path> <value>                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Generic dotted-path setter. Resolves the path against a fresh
 * config object (used purely as a structural template so we can
 * detect whether the target is an array), then mutates the
 * current persisted config and re-validates.
 *
 * Coercion rules — applied to scalar (non-array) targets and to
 * single-element-array shorthand for array targets:
 *   - `"true"` / `"false"` → boolean
 *   - decimal integer (`/^-?\d+$/`) → number
 *   - everything else → string
 *
 * For array targets:
 *   - A literal `"[]"` clears the array.
 *   - A value parseable as a JSON array → that array.
 *   - Otherwise → `[coerce(value)]` (one-element array).
 */
export function cmdSet(archive: string, dottedPath: string, rawValue: string): PopupConfig {
  if (dottedPath.length === 0) throw new Error("set: empty path");
  return withDb(archive, (db) => {
    const c = readConfig(db);
    const segments = dottedPath.split(".");
    setAtPath(c, segments, rawValue);
    return writeConfig(db, c);
  });
}

/** Walk `path` into `obj` and assign `value` (coerced) at the leaf. */
function setAtPath(obj: unknown, path: string[], rawValue: string): void {
  if (path.length === 0) throw new Error("set: empty path");
  let cursor: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (seg == null || !isRecord(cursor) || !(seg in cursor)) {
      throw new Error(`set: unknown path segment "${seg ?? ""}" in "${path.join(".")}"`);
    }
    cursor = cursor[seg];
  }
  const leaf = path[path.length - 1];
  if (leaf == null || !isRecord(cursor) || !(leaf in cursor)) {
    throw new Error(`set: unknown path "${path.join(".")}"`);
  }
  const existing = cursor[leaf];
  if (Array.isArray(existing)) {
    cursor[leaf] = coerceArrayValue(rawValue);
  } else if (existing != null && typeof existing === "object") {
    throw new Error(
      `set: cannot assign scalar to object path "${path.join(".")}"; use a deeper dotted path or an array helper`,
    );
  } else {
    cursor[leaf] = coerceScalar(rawValue);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function coerceScalar(raw: string): boolean | number | string {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

function coerceArrayValue(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to the single-value wrap
    }
  }
  return [coerceScalar(raw)];
}

/* -------------------------------------------------------------------------- */
/* Schedule helpers                                                           */
/* -------------------------------------------------------------------------- */

const TIME_RANGE_RE = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;
const DAY_ORDER: readonly DayOfWeek[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/**
 * Parse a `<days>` argument. Three accepted shapes:
 *   - `"mon"`         → ["mon"]
 *   - `"mon-fri"`     → inclusive day-range in `DAY_ORDER`
 *   - `"mon,wed,fri"` → comma-separated list (whitespace-tolerant)
 * Anything else throws with a helpful pointer.
 */
export function parseDaysSpec(spec: string): DayOfWeek[] {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new Error("schedule: empty days spec");
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim().toLowerCase());
    return parts.map((p) => parseSingleDay(p));
  }
  if (trimmed.includes("-")) {
    const [a, b] = trimmed.split("-").map((s) => s.trim().toLowerCase());
    if (!a || !b) throw new Error(`schedule: bad day range "${spec}"`);
    const start = parseSingleDay(a);
    const end = parseSingleDay(b);
    const sIdx = DAY_ORDER.indexOf(start);
    const eIdx = DAY_ORDER.indexOf(end);
    if (sIdx < 0 || eIdx < 0) throw new Error(`schedule: bad day range "${spec}"`);
    if (sIdx <= eIdx) return DAY_ORDER.slice(sIdx, eIdx + 1);
    // Allow wrap-around — `fri-mon` = fri,sat,sun,mon.
    return [...DAY_ORDER.slice(sIdx), ...DAY_ORDER.slice(0, eIdx + 1)];
  }
  return [parseSingleDay(trimmed.toLowerCase())];
}

function parseSingleDay(s: string): DayOfWeek {
  const parsed = DayOfWeekSchema.safeParse(s);
  if (!parsed.success) {
    throw new Error(
      `schedule: not a day code: "${s}" (expected one of ${DAY_ORDER.join(",")})`,
    );
  }
  return parsed.data;
}

/** Parse `HH:MM-HH:MM` into the two HH:MM strings (validation only). */
export function parseTimeRange(spec: string): { start: string; end: string } {
  const m = spec.trim().match(TIME_RANGE_RE);
  const start = m?.[1];
  const end = m?.[2];
  if (!m || start == null || end == null) {
    throw new Error(
      `schedule: bad time range "${spec}" — expected HH:MM-HH:MM (e.g. 09:00-18:00)`,
    );
  }
  return { start, end };
}

/**
 * Append a window to `schedule.windows`. Does NOT flip
 * `schedule.enabled` — that's a separate gesture so the user can
 * build up the window list before they go live with the gate.
 */
export function cmdScheduleAdd(archive: string, daysSpec: string, timeSpec: string): PopupConfig {
  const days = parseDaysSpec(daysSpec);
  const { start, end } = parseTimeRange(timeSpec);
  return withDb(archive, (db) => {
    const c = readConfig(db);
    const w: ScheduleWindow = { days, start, end };
    c.schedule.windows.push(w);
    return writeConfig(db, c);
  });
}

export function cmdScheduleClear(archive: string): PopupConfig {
  return withDb(archive, (db) => {
    const c = readConfig(db);
    c.schedule.windows = [];
    return writeConfig(db, c);
  });
}

export function cmdScheduleEnable(archive: string, enabled: boolean): PopupConfig {
  return withDb(archive, (db) => {
    const c = readConfig(db);
    c.schedule.enabled = enabled;
    return writeConfig(db, c);
  });
}

/* -------------------------------------------------------------------------- */
/* Export / import                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Serialise the current config to `outPath`. Writes a pretty JSON
 * doc with a trailing newline so the file is git-friendly.
 */
export function cmdExport(archive: string, outPath: string): { path: string; config: PopupConfig } {
  const c = cmdGet(archive);
  writeFileSync(outPath, formatConfig(c));
  return { path: outPath, config: c };
}

/**
 * Read `inPath`, validate through the schema (with URL-regex
 * compilation), and replace the persisted config. Returns the
 * (validated, defaulted) config that was written.
 */
export function cmdImport(archive: string, inPath: string): PopupConfig {
  let raw: string;
  try {
    raw = readFileSync(inPath, "utf8");
  } catch (e) {
    throw new Error(
      `import: failed to read ${inPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `import: ${inPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const v = PopupConfigSchema.safeParse(parsed);
  if (!v.success) {
    throw new Error(`import: ${inPath} failed validation: ${v.error.message}`);
  }
  return withDb(archive, (db) => writeConfig(db, v.data));
}

/* -------------------------------------------------------------------------- */
/* Queue maintenance (v0.9.1)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Delete every `status='failed'` row from the queue. Returns the
 * count of rows removed. Backs `swrag meeting queue clear-failed`.
 *
 * Lives here (alongside the other CLI-adapter functions) rather than
 * in `src/cli.ts` so it's directly importable from tests. The CLI
 * wrapper in `src/cli.ts` does daemon-route-first via
 * `queue_clear_failed`, falling back to this function when the
 * daemon isn't running.
 */
export function cmdClearFailed(archive: string): number {
  return withDb(archive, (db) => deleteFailedRows(db));
}

/* -------------------------------------------------------------------------- */
/* Re-exports for the test suite + CLI                                        */
/* -------------------------------------------------------------------------- */

export { defaultConfig };
