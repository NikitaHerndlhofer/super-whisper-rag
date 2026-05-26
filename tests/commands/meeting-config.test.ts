/**
 * Tests for the `swrag meeting config …` underlying functions
 * (v0.8.0).
 *
 * Each subcommand maps 1:1 onto an exported function in
 * `src/commands/meeting-config.ts`. The citty wrappers in
 * `src/cli.ts` are thin parsers; the behaviour worth covering lives
 * here:
 *
 *   - dotted-path `set` with scalar / array / boolean / numeric
 *     coercion, including the `[]` clear-form
 *   - list ops are idempotent on add, lenient on remove
 *   - schedule add accepts the three day-spec shapes (single,
 *     range, comma list) and rejects malformed time ranges
 *   - export / import round-trip through a temp file
 *   - every write surfaces zod errors at the write boundary (we do
 *     NOT persist a config the schema would reject)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdClearFailed,
  cmdExport,
  cmdGet,
  cmdImport,
  cmdListOp,
  cmdReset,
  cmdScheduleAdd,
  cmdScheduleClear,
  cmdScheduleEnable,
  cmdSet,
  parseDaysSpec,
  parseTimeRange,
} from "../../src/commands/meeting-config.ts";
import { openArchive } from "../../src/archive/open.ts";
import {
  enqueue,
  getById,
  markFailed,
  markTranscribing,
} from "../../src/meeting/queue.ts";

let workDir: string;
let archive: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-cli-config-"));
  archive = join(workDir, "archive.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* get / reset                                                                */
/* -------------------------------------------------------------------------- */

describe("cmdGet / cmdReset", () => {
  test("get on a fresh archive returns defaults", () => {
    const c = cmdGet(archive);
    expect(c.threshold).toBe("HIGH");
    expect(c.schedule.enabled).toBe(false);
    expect(c.allowlist.bundle_ids).toEqual([]);
  });

  test("reset overwrites a mutated config with defaults", () => {
    cmdSet(archive, "threshold", "MEDIUM");
    expect(cmdGet(archive).threshold).toBe("MEDIUM");
    const c = cmdReset(archive);
    expect(c.threshold).toBe("HIGH");
    expect(cmdGet(archive).threshold).toBe("HIGH");
  });
});

/* -------------------------------------------------------------------------- */
/* set: coercion + dotted paths                                               */
/* -------------------------------------------------------------------------- */

describe("cmdSet — scalar paths", () => {
  test("threshold (enum) round-trips", () => {
    const c = cmdSet(archive, "threshold", "MEDIUM");
    expect(c.threshold).toBe("MEDIUM");
  });

  test("threshold rejects a value that zod would refuse (error surfaces at write)", () => {
    expect(() => cmdSet(archive, "threshold", "ALWAYS")).toThrow();
  });

  test("schedule.enabled coerces 'true' / 'false' to boolean", () => {
    const on = cmdSet(archive, "schedule.enabled", "true");
    expect(on.schedule.enabled).toBe(true);
    const off = cmdSet(archive, "schedule.enabled", "false");
    expect(off.schedule.enabled).toBe(false);
  });

  test("schedule.timezone stays a string when value is non-bool / non-int", () => {
    const c = cmdSet(archive, "schedule.timezone", "America/New_York");
    expect(c.schedule.timezone).toBe("America/New_York");
  });

  test("unknown dotted path throws", () => {
    expect(() => cmdSet(archive, "nope.also_nope", "x")).toThrow();
  });

  test("assigning a scalar to an object path throws (would corrupt schema)", () => {
    expect(() => cmdSet(archive, "schedule", "true")).toThrow();
  });

  test("hotkeys.stop_recording (v0.9.11) coerces opt-in hotkey string through", () => {
    const c = cmdSet(archive, "hotkeys.stop_recording", "cmd+shift+s");
    expect(c.hotkeys.stop_recording).toBe("cmd+shift+s");
  });

  test("hotkeys.stop_recording: a fresh archive starts with the value defaulted to null", () => {
    expect(cmdGet(archive).hotkeys.stop_recording).toBeNull();
  });
});

describe("cmdSet — array paths", () => {
  test("single value wraps as one-element array", () => {
    const c = cmdSet(archive, "allowlist.bundle_ids", "us.zoom.xos");
    expect(c.allowlist.bundle_ids).toEqual(["us.zoom.xos"]);
  });

  test("[] clears the array", () => {
    cmdListOp(archive, "allow-app", "us.zoom.xos");
    cmdListOp(archive, "allow-app", "com.tinyspeck.slackmacgap");
    const c = cmdSet(archive, "allowlist.bundle_ids", "[]");
    expect(c.allowlist.bundle_ids).toEqual([]);
  });

  test("JSON-array literal replaces wholesale", () => {
    const c = cmdSet(archive, "blocklist.bundle_ids", '["a","b","c"]');
    expect(c.blocklist.bundle_ids).toEqual(["a", "b", "c"]);
  });

  test("malformed JSON-array literal falls back to one-element wrap", () => {
    // `[unclosed` doesn't parse — treated as a single-element wrap.
    const c = cmdSet(archive, "allowlist.bundle_ids", "[unclosed");
    expect(c.allowlist.bundle_ids).toEqual(["[unclosed"]);
  });
});

/* -------------------------------------------------------------------------- */
/* allow / block list ops                                                     */
/* -------------------------------------------------------------------------- */

describe("cmdListOp", () => {
  test("allow-app: add is idempotent", () => {
    cmdListOp(archive, "allow-app", "us.zoom.xos");
    cmdListOp(archive, "allow-app", "us.zoom.xos");
    const c = cmdGet(archive);
    expect(c.allowlist.bundle_ids).toEqual(["us.zoom.xos"]);
  });

  test("unallow-app: remove existing entry, no-op on missing entry", () => {
    cmdListOp(archive, "allow-app", "us.zoom.xos");
    cmdListOp(archive, "unallow-app", "us.zoom.xos");
    expect(cmdGet(archive).allowlist.bundle_ids).toEqual([]);
    // Repeat unallow on missing entry — no error.
    expect(() => cmdListOp(archive, "unallow-app", "us.zoom.xos")).not.toThrow();
  });

  test("block-url validates regex at write boundary", () => {
    expect(() => cmdListOp(archive, "block-url", "(badregex")).toThrow();
    // Confirm nothing was persisted on the failure.
    expect(cmdGet(archive).blocklist.url_patterns).toEqual([]);
  });

  test("allow-url accepts a valid regex string", () => {
    const c = cmdListOp(archive, "allow-url", "^https://meet\\.google\\.com/");
    expect(c.allowlist.url_patterns).toEqual(["^https://meet\\.google\\.com/"]);
  });

  test("unblock-url removes the matching pattern", () => {
    cmdListOp(archive, "block-url", "zoom\\.us");
    cmdListOp(archive, "block-url", "webex\\.com");
    cmdListOp(archive, "unblock-url", "zoom\\.us");
    expect(cmdGet(archive).blocklist.url_patterns).toEqual(["webex\\.com"]);
  });
});

/* -------------------------------------------------------------------------- */
/* schedule add / clear / enable / disable                                    */
/* -------------------------------------------------------------------------- */

describe("parseDaysSpec", () => {
  test('single day: "mon" → ["mon"]', () => {
    expect(parseDaysSpec("mon")).toEqual(["mon"]);
  });

  test('range: "mon-fri" → mon..fri', () => {
    expect(parseDaysSpec("mon-fri")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  test('range: "fri-mon" wraps around the week', () => {
    expect(parseDaysSpec("fri-mon")).toEqual(["fri", "sat", "sun", "mon"]);
  });

  test('comma list: "sat,sun" preserves order', () => {
    expect(parseDaysSpec("sat,sun")).toEqual(["sat", "sun"]);
  });

  test("whitespace-tolerant inside comma list", () => {
    expect(parseDaysSpec("mon, wed , fri")).toEqual(["mon", "wed", "fri"]);
  });

  test("case-insensitive", () => {
    expect(parseDaysSpec("MON-FRI")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  test("bad day throws with a helpful message", () => {
    expect(() => parseDaysSpec("funday")).toThrow(/day code/);
  });
});

describe("parseTimeRange", () => {
  test('"09:00-18:00" parses', () => {
    expect(parseTimeRange("09:00-18:00")).toEqual({ start: "09:00", end: "18:00" });
  });

  test("malformed values throw with HH:MM-HH:MM hint", () => {
    expect(() => parseTimeRange("9-18")).toThrow(/HH:MM-HH:MM/);
    expect(() => parseTimeRange("09:00 - 18:00")).toThrow(/HH:MM-HH:MM/);
  });
});

describe("cmdScheduleAdd", () => {
  test("adds a single window with the parsed days + times", () => {
    const c = cmdScheduleAdd(archive, "mon-fri", "09:00-18:00");
    expect(c.schedule.windows).toEqual([
      { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00" },
    ]);
    // Does NOT auto-enable the schedule.
    expect(c.schedule.enabled).toBe(false);
  });

  test("subsequent adds append rather than replace", () => {
    cmdScheduleAdd(archive, "mon-fri", "09:00-12:00");
    const c = cmdScheduleAdd(archive, "mon-fri", "14:00-17:00");
    expect(c.schedule.windows).toHaveLength(2);
    expect(c.schedule.windows[1]?.start).toBe("14:00");
  });
});

describe("cmdScheduleClear / Enable / Disable", () => {
  test("clear empties the windows array", () => {
    cmdScheduleAdd(archive, "mon-fri", "09:00-18:00");
    const c = cmdScheduleClear(archive);
    expect(c.schedule.windows).toEqual([]);
  });

  test("enable / disable flip the flag", () => {
    const on = cmdScheduleEnable(archive, true);
    expect(on.schedule.enabled).toBe(true);
    const off = cmdScheduleEnable(archive, false);
    expect(off.schedule.enabled).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* export / import                                                            */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* clear-failed (v0.9.1)                                                      */
/* -------------------------------------------------------------------------- */

describe("cmdClearFailed", () => {
  test("returns 0 on an empty queue", () => {
    expect(cmdClearFailed(archive)).toBe(0);
  });

  test("deletes every failed row, leaves pending and transcribing alone", () => {
    const db = openArchive(archive, {});
    let pendingId = 0;
    let transcribingId = 0;
    try {
      const a = enqueue(db, { audio_path: "/tmp/a.wav", captured_at: "2026-05-22T00:00:00Z" });
      const b = enqueue(db, { audio_path: "/tmp/b.wav", captured_at: "2026-05-22T01:00:00Z" });
      const c = enqueue(db, { audio_path: "/tmp/c.wav", captured_at: "2026-05-22T02:00:00Z" });
      const d = enqueue(db, { audio_path: "/tmp/d.wav", captured_at: "2026-05-22T03:00:00Z" });
      markFailed(db, a.id, "x");
      markFailed(db, b.id, "y");
      markTranscribing(db, c.id);
      pendingId = d.id;
      transcribingId = c.id;
    } finally {
      db.close();
    }
    const n = cmdClearFailed(archive);
    expect(n).toBe(2);
    const db2 = openArchive(archive, {});
    try {
      expect(getById(db2, pendingId)?.status).toBe("pending");
      expect(getById(db2, transcribingId)?.status).toBe("transcribing");
    } finally {
      db2.close();
    }
    // Re-running is a no-op (idempotent).
    expect(cmdClearFailed(archive)).toBe(0);
  });
});

describe("cmdExport / cmdImport", () => {
  test("export writes a parseable JSON file with the live config", () => {
    cmdSet(archive, "threshold", "MEDIUM");
    cmdListOp(archive, "allow-app", "us.zoom.xos");
    const outPath = join(workDir, "config.json");
    const r = cmdExport(archive, outPath);
    expect(r.path).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
    expect(onDisk.threshold).toBe("MEDIUM");
    expect(onDisk.allowlist.bundle_ids).toEqual(["us.zoom.xos"]);
  });

  test("import replaces the live config; round-trips with export", () => {
    cmdSet(archive, "threshold", "NEVER");
    const outPath = join(workDir, "before.json");
    cmdExport(archive, outPath);
    cmdReset(archive);
    expect(cmdGet(archive).threshold).toBe("HIGH");
    const restored = cmdImport(archive, outPath);
    expect(restored.threshold).toBe("NEVER");
  });

  test("import rejects malformed JSON", () => {
    const badPath = join(workDir, "bad.json");
    writeFileSync(badPath, "{not json at all");
    expect(() => cmdImport(archive, badPath)).toThrow(/not valid JSON/);
  });

  test("import rejects a JSON doc that fails the schema", () => {
    const badPath = join(workDir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ threshold: "ALWAYS" }));
    expect(() => cmdImport(archive, badPath)).toThrow(/failed validation/);
  });

  test("import compiles URL regexes (rejects bad ones)", () => {
    const badPath = join(workDir, "bad.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        threshold: "HIGH",
        schedule: { enabled: false, timezone: "local", windows: [] },
        allowlist: { bundle_ids: [], url_patterns: ["(unclosed"] },
        blocklist: { bundle_ids: [], url_patterns: [] },
      }),
    );
    expect(() => cmdImport(archive, badPath)).toThrow();
  });
});
