/**
 * Tests for the meeting popup config (v0.8.0).
 *
 * Coverage focus:
 *   - Schema defaults match v0.7.0 behaviour exactly (threshold=HIGH,
 *     no schedule, empty allow/block lists).
 *   - Partial input fills in defaults at parse time.
 *   - Validation rejects bad shapes early (HH:MM, day enums, regex).
 *   - DB I/O round-trips: write → read returns an equivalent value.
 *   - resetConfig() restores defaults regardless of prior state.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive, setConfig, getConfig } from "../../src/archive/open.ts";
import {
  defaultConfig,
  POPUP_CONFIG_KEY,
  PopupConfigSchema,
  ScheduleWindowSchema,
  readConfig,
  resetConfig,
  validateUrlPatterns,
  writeConfig,
} from "../../src/meeting/config.ts";

let workDir: string;
let archive: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-config-"));
  archive = join(workDir, "archive.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Schema defaults + validation                                               */
/* -------------------------------------------------------------------------- */

describe("PopupConfigSchema defaults", () => {
  test("empty input fills in v0.7.0-equivalent defaults", () => {
    const c = PopupConfigSchema.parse({});
    expect(c.threshold).toBe("HIGH");
    expect(c.schedule.enabled).toBe(false);
    expect(c.schedule.timezone).toBe("local");
    expect(c.schedule.windows).toEqual([]);
    expect(c.allowlist).toEqual({ bundle_ids: [], url_patterns: [] });
    expect(c.blocklist).toEqual({ bundle_ids: [], url_patterns: [] });
    // v0.9.11: hotkeys default to null (no global shortcuts armed).
    expect(c.hotkeys).toEqual({ stop_recording: null });
  });

  test("hotkeys.stop_recording: legacy stored config (no hotkeys field) round-trips with the v0.9.11 default", () => {
    // Simulate a v0.9.10 archive — stored JSON predates the
    // `hotkeys` field. Schema must fill in the default rather than
    // reject the row.
    const c = PopupConfigSchema.parse({
      threshold: "HIGH",
      schedule: { enabled: false, timezone: "local", windows: [] },
      allowlist: { bundle_ids: [], url_patterns: [] },
      blocklist: { bundle_ids: [], url_patterns: [] },
    });
    expect(c.hotkeys).toEqual({ stop_recording: null });
  });

  test("hotkeys.stop_recording: accepts a configured string", () => {
    const c = PopupConfigSchema.parse({
      hotkeys: { stop_recording: "cmd+shift+s" },
    });
    expect(c.hotkeys.stop_recording).toBe("cmd+shift+s");
  });

  test("defaultConfig() returns a fresh independent object", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    a.allowlist.bundle_ids.push("ai.perplexity.comet");
    expect(b.allowlist.bundle_ids).toEqual([]);
  });

  test("partial input is filled, untouched fields preserved", () => {
    const c = PopupConfigSchema.parse({ threshold: "MEDIUM" });
    expect(c.threshold).toBe("MEDIUM");
    expect(c.schedule.enabled).toBe(false);
    expect(c.allowlist.bundle_ids).toEqual([]);
  });

  test("nested defaults: schedule with only `enabled` set fills in timezone + windows", () => {
    const c = PopupConfigSchema.parse({ schedule: { enabled: true } });
    expect(c.schedule.enabled).toBe(true);
    expect(c.schedule.timezone).toBe("local");
    expect(c.schedule.windows).toEqual([]);
  });
});

describe("PopupConfigSchema validation rejects bad values", () => {
  test("threshold must be one of HIGH | MEDIUM | NEVER", () => {
    expect(() => PopupConfigSchema.parse({ threshold: "ALWAYS" })).toThrow();
    expect(() => PopupConfigSchema.parse({ threshold: "high" })).toThrow();
  });

  test("schedule.windows: each must have at least one day", () => {
    expect(() =>
      ScheduleWindowSchema.parse({ days: [], start: "09:00", end: "17:00" }),
    ).toThrow();
  });

  test("schedule.windows: bad day enum is rejected", () => {
    expect(() =>
      ScheduleWindowSchema.parse({ days: ["funday"], start: "09:00", end: "17:00" }),
    ).toThrow();
  });

  test("schedule.windows: HH:MM format enforced", () => {
    expect(() => ScheduleWindowSchema.parse({ days: ["mon"], start: "9:00", end: "17:00" })).toThrow();
    expect(() =>
      ScheduleWindowSchema.parse({ days: ["mon"], start: "09:00", end: "17:0" }),
    ).toThrow();
    expect(() =>
      ScheduleWindowSchema.parse({ days: ["mon"], start: "0900", end: "1700" }),
    ).toThrow();
  });

  test("happy: a fully-spelled-out window parses through", () => {
    const w = ScheduleWindowSchema.parse({
      days: ["mon", "wed", "fri"],
      start: "09:00",
      end: "17:30",
    });
    expect(w.days).toEqual(["mon", "wed", "fri"]);
    expect(w.start).toBe("09:00");
    expect(w.end).toBe("17:30");
  });
});

describe("validateUrlPatterns", () => {
  test("compiles every allow + block url pattern; throws on bad regex with the offending one in the message", () => {
    const cfg = defaultConfig();
    cfg.allowlist.url_patterns = ["https://meet\\.google\\.com/", "[unclosed"];
    expect(() => validateUrlPatterns(cfg)).toThrow(/allowlist.url_patterns.*\[unclosed/);
  });

  test("blocklist patterns are also checked", () => {
    const cfg = defaultConfig();
    cfg.blocklist.url_patterns = ["(also-unclosed"];
    expect(() => validateUrlPatterns(cfg)).toThrow(/blocklist.url_patterns/);
  });

  test("a list of valid patterns passes silently", () => {
    const cfg = defaultConfig();
    cfg.allowlist.url_patterns = ["^https://meet\\.google\\.com/", ".*"];
    cfg.blocklist.url_patterns = ["zoom\\.us"];
    expect(() => validateUrlPatterns(cfg)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* DB I/O round-trip                                                          */
/* -------------------------------------------------------------------------- */

describe("readConfig / writeConfig", () => {
  test("readConfig on a fresh archive returns defaults (no stored row)", () => {
    const db = openArchive(archive, {});
    try {
      const c = readConfig(db);
      expect(c.threshold).toBe("HIGH");
      expect(c.schedule.enabled).toBe(false);
      expect(c.allowlist).toEqual({ bundle_ids: [], url_patterns: [] });
    } finally {
      db.close();
    }
  });

  test("writeConfig then readConfig round-trips", () => {
    const db = openArchive(archive, {});
    try {
      const before = defaultConfig();
      before.threshold = "MEDIUM";
      before.schedule.enabled = true;
      before.schedule.timezone = "America/New_York";
      before.schedule.windows.push({ days: ["mon", "tue"], start: "09:00", end: "17:00" });
      before.allowlist.bundle_ids.push("us.zoom.xos");
      before.allowlist.url_patterns.push("^https://meet\\.google\\.com/");
      before.blocklist.bundle_ids.push("com.tinyspeck.slackmacgap");
      writeConfig(db, before);
      const after = readConfig(db);
      expect(after).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("writeConfig validates URL patterns and refuses to write a malformed one", () => {
    const db = openArchive(archive, {});
    try {
      const c = defaultConfig();
      c.allowlist.url_patterns.push("(badregex");
      expect(() => writeConfig(db, c)).toThrow();
      // Confirm nothing was persisted under the key.
      expect(getConfig(db, POPUP_CONFIG_KEY)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("readConfig surfaces a clean error when the stored row is bad JSON", () => {
    const db = openArchive(archive, {});
    try {
      setConfig(db, POPUP_CONFIG_KEY, "{not json");
      expect(() => readConfig(db)).toThrow(/not valid JSON/);
    } finally {
      db.close();
    }
  });

  test("readConfig surfaces a clean error when the stored row is JSON but wrong shape", () => {
    const db = openArchive(archive, {});
    try {
      setConfig(db, POPUP_CONFIG_KEY, JSON.stringify({ threshold: "ALWAYS" }));
      expect(() => readConfig(db)).toThrow(/invalid shape/);
    } finally {
      db.close();
    }
  });

  test("resetConfig() overwrites whatever was there with defaults", () => {
    const db = openArchive(archive, {});
    try {
      const dirty = defaultConfig();
      dirty.threshold = "NEVER";
      dirty.blocklist.bundle_ids.push("us.zoom.xos");
      writeConfig(db, dirty);
      const restored = resetConfig(db);
      expect(restored.threshold).toBe("HIGH");
      expect(restored.blocklist.bundle_ids).toEqual([]);
      const reread = readConfig(db);
      expect(reread).toEqual(restored);
    } finally {
      db.close();
    }
  });
});
