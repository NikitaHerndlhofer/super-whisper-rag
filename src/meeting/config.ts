/**
 * Configurable meeting popup triggers (v0.8.0).
 *
 * One zod schema, persisted as a single JSON blob in the `config`
 * table under `meeting_popup_config`. We deliberately don't normalise
 * the config across multiple rows — the surface is small, the writes
 * are atomic, and the hot-reload op on the daemon socket just
 * re-reads the one key and validates it.
 *
 * Defaults match v0.7.0 behaviour exactly: threshold=HIGH (popup
 * fires only on debounce-confirmed HIGH-confidence signals), no
 * schedule gating, no allow/block lists. A fresh install therefore
 * behaves identically to v0.7.x for any user who never touches
 * `swrag meeting config`.
 *
 * Validation rules worth calling out:
 *   - URL pattern strings must compile as JS regexes. We compile
 *     them eagerly in `writeConfig` (and in the schema's refine on
 *     the regex strings) so a malformed pattern is rejected at the
 *     write boundary rather than discovered at decision time.
 *   - Schedule windows allow `start > end` (midnight-crossing); the
 *     decide-popup logic handles the wrap. We validate the HH:MM
 *     literal shape here and leave semantic wrap-checks to the
 *     decision function.
 *   - `timezone` defaults to the literal string "local"; any other
 *     value must be an IANA tz like "America/New_York" that
 *     Intl.DateTimeFormat accepts. We don't validate IANA names
 *     here because Intl will throw at use-time with a clearer
 *     error message than we'd produce.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { getConfig, setConfig } from "../archive/open.ts";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Config table key under which the JSON-encoded popup config lives. */
export const POPUP_CONFIG_KEY = "meeting_popup_config";

/** Allowed values for the `threshold` knob. Order encodes strictness. */
export const ThresholdSchema = z.enum(["HIGH", "MEDIUM", "NEVER"]);
export type Threshold = z.infer<typeof ThresholdSchema>;

/** Two-letter day codes used by schedule windows. */
export const DayOfWeekSchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type DayOfWeek = z.infer<typeof DayOfWeekSchema>;

const TIME_FORMAT_RE = /^\d{2}:\d{2}$/;

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A single allowed time window. `days` is the days on which the
 * window is active; `start`/`end` are HH:MM (24 h, local-to-tz).
 *
 * If `start > end` the window wraps past midnight — e.g.
 * `22:00-02:00 mon` is "from Monday 22:00 until Tuesday 02:00".
 * The decide-popup function handles the wrap; we just store the
 * literal values here.
 */
export const ScheduleWindowSchema = z.object({
  days: z.array(DayOfWeekSchema).min(1),
  start: z.string().regex(TIME_FORMAT_RE, "expected HH:MM"),
  end: z.string().regex(TIME_FORMAT_RE, "expected HH:MM"),
});
export type ScheduleWindow = z.infer<typeof ScheduleWindowSchema>;

// NOTE on `.default(() => ...)` everywhere below: zod 4's
// `.default(value)` form retains the same object/array REFERENCE
// across `parse()` calls, which leaks mutations between consumers
// (e.g. a test pushing onto `bundle_ids` would extend the "default"
// for the next call). The factory form `.default(() => fresh)`
// re-evaluates per parse and avoids that aliasing entirely.

export const ScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  /** IANA tz, or the literal string "local" for the system tz. */
  timezone: z.string().default("local"),
  windows: z.array(ScheduleWindowSchema).default(() => []),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * Match list — bundle IDs are matched verbatim against the
 * frontmost app's bundle id; url_patterns are JS regex strings
 * matched against the current browser URL. Empty list = no
 * matches (does NOT mean "match everything").
 */
export const MatchListSchema = z.object({
  bundle_ids: z.array(z.string()).default(() => []),
  url_patterns: z.array(z.string()).default(() => []),
});
export type MatchList = z.infer<typeof MatchListSchema>;

export const PopupConfigSchema = z.object({
  threshold: ThresholdSchema.default("HIGH"),
  schedule: ScheduleSchema.default(() => ({ enabled: false, timezone: "local", windows: [] })),
  allowlist: MatchListSchema.default(() => ({ bundle_ids: [], url_patterns: [] })),
  blocklist: MatchListSchema.default(() => ({ bundle_ids: [], url_patterns: [] })),
});
export type PopupConfig = z.infer<typeof PopupConfigSchema>;

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a fresh default config. Each call returns an independent
 * object so callers can mutate freely — the schema's defaults are
 * factory-form (`() => []`), so successive parses don't share
 * array references.
 */
export function defaultConfig(): PopupConfig {
  return PopupConfigSchema.parse({});
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Compile every url_patterns entry in the allow + block lists to
 * surface malformed regex strings at write-time. Throws with a
 * pointer to the offending pattern so the CLI surface can render
 * a useful error.
 */
export function validateUrlPatterns(config: PopupConfig): void {
  const lists: Array<[label: string, patterns: readonly string[]]> = [
    ["allowlist.url_patterns", config.allowlist.url_patterns],
    ["blocklist.url_patterns", config.blocklist.url_patterns],
  ];
  for (const [label, patterns] of lists) {
    for (const p of patterns) {
      try {
        new RegExp(p);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`invalid regex in ${label}: ${JSON.stringify(p)} — ${msg}`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* DB I/O                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read + validate the popup config from the archive. If the key is
 * missing, returns `defaultConfig()`. If the stored value fails
 * to parse (e.g. a hand-edited row gone wrong), throws with the
 * zod error path — the daemon catches and falls back to defaults
 * with a warning, so a malformed config never blocks startup.
 */
export function readConfig(db: Database): PopupConfig {
  const raw = getConfig(db, POPUP_CONFIG_KEY);
  if (raw == null) return defaultConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `meeting_popup_config: stored value is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const result = PopupConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`meeting_popup_config: invalid shape: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Validate + write the config. Re-parses through the schema (so
 * defaults fill in for omitted fields), then compiles every URL
 * regex so we don't store something that decide-popup would
 * crash on. Atomic single-row upsert against the `config` table.
 */
export function writeConfig(db: Database, config: PopupConfig): PopupConfig {
  const parsed = PopupConfigSchema.parse(config);
  validateUrlPatterns(parsed);
  setConfig(db, POPUP_CONFIG_KEY, JSON.stringify(parsed));
  return parsed;
}

/**
 * Restore defaults. Implemented as an explicit write so the
 * `config_reload` socket op picks up the change just like any
 * other CLI mutation.
 */
export function resetConfig(db: Database): PopupConfig {
  return writeConfig(db, defaultConfig());
}
