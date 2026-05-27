import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ensureExtensionCapableSqlite, openArchive } from "../src/archive/open.ts";
import { runMigrations, splitSqlStatements } from "../src/archive/migrate.ts";
import { LATEST_VERSION, MIGRATIONS } from "../src/archive/migrations.ts";
import { vecDylibPath } from "../src/archive/vec-loader.ts";
import { queryAll, queryOne } from "./helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UserVersionRowSchema = z.object({ user_version: z.number() });
const CountRowSchema = z.object({ n: z.number() });

function tempArchivePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "swrag-mig-"));
  return join(dir, "swrag.sqlite");
}

function makeRawDb(): Database {
  ensureExtensionCapableSqlite();
  const db = new Database(":memory:");
  db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
  return db;
}

describe("MIGRATIONS array", () => {
  test("versions are strictly increasing integers", () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      const prev = MIGRATIONS[i - 1];
      const cur = MIGRATIONS[i];
      if (!prev || !cur) throw new Error("missing migration entry");
      expect(cur.version).toBeGreaterThan(prev.version);
      expect(Number.isInteger(cur.version)).toBe(true);
    }
  });

  test("LATEST_VERSION matches the last entry", () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    expect(last?.version).toBe(LATEST_VERSION);
  });

  test("every migration has non-empty SQL", () => {
    for (const m of MIGRATIONS) {
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("runMigrations on a fresh DB", () => {
  test("applies all migrations and bumps PRAGMA user_version", () => {
    const db = makeRawDb();
    try {
      const before = queryOne(db, UserVersionRowSchema, "PRAGMA user_version");
      expect(before.user_version).toBe(0);

      const result = runMigrations(db);
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(LATEST_VERSION);
      expect(result.applied).toEqual(MIGRATIONS.map((m) => m.version));

      const after = queryOne(db, UserVersionRowSchema, "PRAGMA user_version");
      expect(after.user_version).toBe(LATEST_VERSION);
    } finally {
      db.close();
    }
  });

  test("creates the recording table with all expected columns", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      const cols = db
        .prepare("PRAGMA table_info(recording)")
        .all()
        .map((r) => z.object({ name: z.string() }).parse(r).name);
      for (const expected of [
        "folder_name",
        "recording_id_hex",
        "datetime",
        "duration_ms",
        "mode_name",
        "audio_hash",
        "superseded_by",
        "superseded_at",
      ]) {
        expect(cols).toContain(expected);
      }
    } finally {
      db.close();
    }
  });
});

describe("runMigrations idempotency", () => {
  test("re-running on an up-to-date DB applies nothing", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      const second = runMigrations(db);
      expect(second.applied).toEqual([]);
      expect(second.fromVersion).toBe(LATEST_VERSION);
      expect(second.toVersion).toBe(LATEST_VERSION);
    } finally {
      db.close();
    }
  });

  test("simulated old archive (v1 schema, user_version = 0) upgrades to latest", () => {
    const db = makeRawDb();
    try {
      // Apply only the first migration manually, leave user_version at 0
      // — this simulates an archive created before the migration runner
      // existed.
      const init = MIGRATIONS[0];
      if (!init) throw new Error("missing init migration");
      db.exec(init.sql);
      expect(queryOne(db, UserVersionRowSchema, "PRAGMA user_version").user_version).toBe(0);

      const result = runMigrations(db);
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(LATEST_VERSION);
      // Applied list includes init (no-op via IF NOT EXISTS) AND any
      // later migrations.
      expect(result.applied).toEqual(MIGRATIONS.map((m) => m.version));
    } finally {
      db.close();
    }
  });

  test("ALTER TABLE on a column that already exists is tolerated", () => {
    const db = makeRawDb();
    try {
      // Run init, then manually ALTER in one of the v2 columns. The
      // runner should see "duplicate column" on the v2 ALTER and not
      // throw.
      const init = MIGRATIONS[0];
      if (!init) throw new Error("missing init migration");
      db.exec(init.sql);
      db.exec("ALTER TABLE recording ADD COLUMN audio_hash TEXT");

      expect(() => runMigrations(db)).not.toThrow();
      expect(queryOne(db, UserVersionRowSchema, "PRAGMA user_version").user_version).toBe(
        LATEST_VERSION,
      );
    } finally {
      db.close();
    }
  });
});

describe("openArchive runs migrations transparently", () => {
  test("first open of a fresh path lands at LATEST_VERSION", () => {
    const path = tempArchivePath();
    const db = openArchive(path);
    try {
      const row = queryOne(db, UserVersionRowSchema, "PRAGMA user_version");
      expect(row.user_version).toBe(LATEST_VERSION);
      // Smoke: schema is queryable.
      const tables = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name IN ('recording','recording_fts','recording_vec','v_search','config')",
      );
      expect(tables.n).toBe(5);
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });
});

/**
 * Frozen content hashes for every shipped migration.
 *
 * Migrations are append-only by contract — once a version number is
 * shipped, its SQL is immutable. This test fails at CI time if anyone
 * edits a published migration in place.
 *
 * Why it matters: the runner advances `PRAGMA user_version` based on
 * the migration's `version` number and then skips anything with
 * `version <= user_version` on subsequent opens. If you change the
 * body of a published migration without bumping the version, every
 * archive already at or past that version silently never runs the
 * new SQL. That's how the v0.7 -> v1.0 hand-off lost the
 * `meeting_queue` cleanup; v1.1.0 paid the bill with migration 006.
 *
 * To intentionally update a hash here, you must ALSO be adding a new
 * migration that captures whatever change the edited migration was
 * meant to express. Treat any test failure here as a code-review
 * signal, not a number to update mechanically.
 */
const FROZEN_MIGRATION_HASHES: Record<number, string> = {
  1: "8fcd4c87dcabeff76e42403b1bb3fc66890d5675207b4d3dbba2138ae486c928",
  2: "fe639ab3587c81a7f46f938d37db3039b6835184bbfb3f9b2d1603ac37ec4cd7",
  3: "58e0e7e9854a4837917ccb8dd83b37f966cb921e4a7c5a988bee2ce8df1d8be4",
  4: "a0fdb59ff53d4c0cc6f0a271bd43539c3e5b0efb513ddbac5a109bdae0e41263",
  5: "334f6fee522fda819d80d4e974a03b0266ff12df8c17c2b23461705aac715bb5",
  6: "b6067c163713bb5a7c48a71c309e9ae60860777151cab464e71e535510c44a98",
};

describe("shipped migrations are immutable", () => {
  test("every MIGRATIONS entry has a frozen hash, matching its sha256", () => {
    for (const m of MIGRATIONS) {
      const expected = FROZEN_MIGRATION_HASHES[m.version];
      if (!expected) {
        throw new Error(
          `migration ${m.version} (${m.name}) has no entry in ` +
            `FROZEN_MIGRATION_HASHES. Compute its sha256 and add it ` +
            `when shipping a new migration.`,
        );
      }
      const actual = createHash("sha256").update(m.sql).digest("hex");
      expect(actual).toBe(expected);
    }
  });

  test("every frozen hash corresponds to a registered migration", () => {
    const knownVersions = new Set(MIGRATIONS.map((m) => m.version));
    for (const version of Object.keys(FROZEN_MIGRATION_HASHES).map(Number)) {
      expect(knownVersions.has(version)).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- *
 * Migration 006 — transcript schema + datetime_iso + v0.9 redo
 * ---------------------------------------------------------------- */

const TranscriptRowSchema = z.object({
  folder_name: z.string(),
  raw_transcript: z.string().nullable(),
  processed_transcript: z.string().nullable(),
  processed_word_count: z.number().int(),
});
const DatetimeRowSchema = z.object({
  folder_name: z.string(),
  datetime_iso: z.string().nullable(),
});
const FtsRowSchema = z.object({ folder_name: z.string() });
const TableNameRowSchema = z.object({ name: z.string() });
const ConfigKeyRowSchema = z.object({ key: z.string() });
const IndexNameRowSchema = z.object({ name: z.string() });

function insertSampleRow(
  db: Database,
  folderName: string,
  data: {
    datetime: string;
    raw_result: string | null;
    result: string | null;
    llm_result?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO recording (
       folder_name, recording_id_hex, datetime, duration_ms, mode_name,
       raw_result, result, llm_result, indexed_at, meta_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    folderName,
    "deadbeef",
    data.datetime,
    1000,
    "Universal",
    data.raw_result,
    data.result,
    data.llm_result ?? null,
    "2026-01-01T00:00:00Z",
    `/tmp/${folderName}/meta.json`,
  );
}

describe("migration 006: transcript columns", () => {
  test("raw_transcript mirrors raw_result", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-llm", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "scribe output here",
        result: "polished LLM output",
      });
      const row = queryOne(
        db,
        TranscriptRowSchema,
        "SELECT folder_name, raw_transcript, processed_transcript, processed_word_count " +
          "FROM recording WHERE folder_name = 'f-llm'",
      );
      expect(row.raw_transcript).toBe("scribe output here");
    } finally {
      db.close();
    }
  });

  test("processed_transcript is the result when LLM modified raw", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      // New-SW shape: LLM output in `result`, llm_result empty —
      // the exact bug case this migration fixes.
      insertSampleRow(db, "f-new-sw", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "Hello there how are you",
        result: "Hello, there. How are you?",
        llm_result: null,
      });
      const row = queryOne(
        db,
        TranscriptRowSchema,
        "SELECT folder_name, raw_transcript, processed_transcript, processed_word_count " +
          "FROM recording WHERE folder_name = 'f-new-sw'",
      );
      expect(row.processed_transcript).toBe("Hello, there. How are you?");
      expect(row.processed_word_count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("processed_transcript is NULL for voice-only modes (result mirrors raw)", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-voice", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "raw voice text",
        result: "raw voice text",
      });
      const row = queryOne(
        db,
        TranscriptRowSchema,
        "SELECT folder_name, raw_transcript, processed_transcript, processed_word_count " +
          "FROM recording WHERE folder_name = 'f-voice'",
      );
      expect(row.processed_transcript).toBeNull();
      expect(row.processed_word_count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("processed_transcript is NULL when result is empty or missing", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-empty", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "raw",
        result: "",
      });
      insertSampleRow(db, "f-null", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "raw",
        result: null,
      });
      const rows = queryAll(
        db,
        TranscriptRowSchema,
        "SELECT folder_name, raw_transcript, processed_transcript, processed_word_count " +
          "FROM recording WHERE folder_name LIKE 'f-empty' OR folder_name LIKE 'f-null'",
      );
      for (const r of rows) {
        expect(r.processed_transcript).toBeNull();
        expect(r.processed_word_count).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  test("legacy SW shape (llm_result populated, result mirrors raw) still derives correctly", () => {
    // Old SW: llm_result is the LLM output but `result` also got it.
    // The user's data shows old SW always mirrored llm into result,
    // so processed_transcript reflects whichever path SW used.
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-old-sw", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "raw scribe",
        result: "polished LLM",
        llm_result: "polished LLM",
      });
      const row = queryOne(
        db,
        TranscriptRowSchema,
        "SELECT folder_name, raw_transcript, processed_transcript, processed_word_count " +
          "FROM recording WHERE folder_name = 'f-old-sw'",
      );
      expect(row.raw_transcript).toBe("raw scribe");
      expect(row.processed_transcript).toBe("polished LLM");
    } finally {
      db.close();
    }
  });
});

describe("migration 006: FTS rebuild", () => {
  test("FTS indexes raw_transcript and finds raw-only matches", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-raw", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "alpaca grazing meadow",
        result: null,
      });
      const matches = queryAll(
        db,
        FtsRowSchema,
        "SELECT folder_name FROM recording_fts WHERE recording_fts MATCH 'alpaca'",
      );
      expect(matches.map((m) => m.folder_name)).toContain("f-raw");
    } finally {
      db.close();
    }
  });

  test("FTS indexes processed_transcript and finds LLM-only matches", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-llm", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "boring raw text",
        result: "vibrant pterodactyl narrative",
      });
      const matches = queryAll(
        db,
        FtsRowSchema,
        "SELECT folder_name FROM recording_fts WHERE recording_fts MATCH 'pterodactyl'",
      );
      expect(matches.map((m) => m.folder_name)).toContain("f-llm");
    } finally {
      db.close();
    }
  });

  test("FTS update trigger refreshes the index when result changes", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-mut", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "raw text",
        result: "original llm",
      });
      const before = queryAll(
        db,
        FtsRowSchema,
        "SELECT folder_name FROM recording_fts WHERE recording_fts MATCH 'original'",
      );
      expect(before.map((m) => m.folder_name)).toContain("f-mut");
      db.exec("UPDATE recording SET result = 'updated llm' WHERE folder_name = 'f-mut'");
      const afterOld = queryAll(
        db,
        FtsRowSchema,
        "SELECT folder_name FROM recording_fts WHERE recording_fts MATCH 'original'",
      );
      const afterNew = queryAll(
        db,
        FtsRowSchema,
        "SELECT folder_name FROM recording_fts WHERE recording_fts MATCH 'updated'",
      );
      expect(afterOld.map((m) => m.folder_name)).not.toContain("f-mut");
      expect(afterNew.map((m) => m.folder_name)).toContain("f-mut");
    } finally {
      db.close();
    }
  });
});

describe("migration 006: datetime_iso", () => {
  test("normalizes space-separated datetime to ISO8601 with T and Z", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-space", {
        datetime: "2026-05-27 18:39:33.470",
        raw_result: "x",
        result: null,
      });
      const row = queryOne(
        db,
        DatetimeRowSchema,
        "SELECT folder_name, datetime_iso FROM recording WHERE folder_name = 'f-space'",
      );
      expect(row.datetime_iso).toBe("2026-05-27T18:39:33.470Z");
    } finally {
      db.close();
    }
  });

  test("preserves already-ISO datetime", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      insertSampleRow(db, "f-iso", {
        datetime: "2026-05-27T18:39:33.470Z",
        raw_result: "x",
        result: null,
      });
      const row = queryOne(
        db,
        DatetimeRowSchema,
        "SELECT folder_name, datetime_iso FROM recording WHERE folder_name = 'f-iso'",
      );
      expect(row.datetime_iso).toBe("2026-05-27T18:39:33.470Z");
    } finally {
      db.close();
    }
  });

  test("ORDER BY datetime_iso sorts mixed-format datetimes correctly", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      // Two rows where lex order of `datetime` would flip them
      // (T > space) but ISO order should be by actual time:
      //   - earlier in absolute time, written in legacy format
      //   - later in absolute time, written in new format
      insertSampleRow(db, "f-legacy-later", {
        datetime: "2026-05-27 23:00:00.000",
        raw_result: "x",
        result: null,
      });
      insertSampleRow(db, "f-new-earlier", {
        datetime: "2026-05-26T08:00:00.000Z",
        raw_result: "x",
        result: null,
      });
      const rows = queryAll(
        db,
        DatetimeRowSchema,
        "SELECT folder_name, datetime_iso FROM recording WHERE folder_name LIKE 'f-%' " +
          "ORDER BY datetime_iso ASC",
      );
      const order = rows.map((r) => r.folder_name);
      expect(order.indexOf("f-new-earlier")).toBeLessThan(order.indexOf("f-legacy-later"));
    } finally {
      db.close();
    }
  });

  test("idx_recording_datetime_iso index is present", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      const indexes = queryAll(
        db,
        IndexNameRowSchema,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_recording_datetime_iso'",
      );
      expect(indexes).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("migration 006: v0.9 cleanup redo", () => {
  test("on a fresh archive, no meeting_queue table exists", () => {
    const db = makeRawDb();
    try {
      runMigrations(db);
      const tables = queryAll(
        db,
        TableNameRowSchema,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_queue'",
      );
      expect(tables).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  /**
   * The exact bug we hit with the user's archive: v0.7.0 shipped
   * `005_meeting_queue.sql` (CREATE meeting_queue) which bumped
   * user_version to 5. v1.0.0 replaced it with `005_cleanup_v09.sql`
   * (DROP TABLE) but the runner — correctly, per its contract —
   * skipped any version <= 5. So the user's archive still has the
   * table. v1.1.0's migration 006 redoes the cleanup.
   *
   * This test simulates exactly that history: build a v0.7-shape
   * archive (init + meeting_queue), set user_version = 5 by hand,
   * run migrations, and assert the table and config rows are gone.
   */
  test("v0.7 -> v1.0 -> v1.1 upgrade: archive at user_version=5 with meeting_queue still drops it", () => {
    const db = makeRawDb();
    try {
      // Apply migrations 1-4 (everything before the version-5 reuse).
      for (const m of MIGRATIONS) {
        if (m.version <= 4) db.exec(m.sql);
      }
      // Simulate what v0.7's 005_meeting_queue.sql would have done.
      db.exec(
        "CREATE TABLE meeting_queue (id INTEGER PRIMARY KEY, state TEXT NOT NULL)",
      );
      db.exec("INSERT INTO meeting_queue (id, state) VALUES (1, 'paused')");
      // Simulate the v0.9 meeting config rows.
      db.exec("INSERT INTO config (key, value) VALUES ('meeting_queue_state', 'paused')");
      db.exec(
        "INSERT INTO config (key, value) VALUES ('meeting_system_audio_default', '1')",
      );
      // And the v0.7 binary's user_version bump to 5.
      db.exec("PRAGMA user_version = 5");

      // Now run the v1.1 binary's migrations. Only version 6 is pending.
      const outcome = runMigrations(db);
      expect(outcome.fromVersion).toBe(5);
      expect(outcome.toVersion).toBe(LATEST_VERSION);
      expect(outcome.applied).toEqual([6]);

      const tables = queryAll(
        db,
        TableNameRowSchema,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_queue'",
      );
      expect(tables).toHaveLength(0);

      const meetingConfig = queryAll(
        db,
        ConfigKeyRowSchema,
        "SELECT key FROM config WHERE key LIKE 'meeting_%'",
      );
      expect(meetingConfig).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("splitSqlStatements", () => {
  test("splits on top-level semicolons", () => {
    const stmts = splitSqlStatements("SELECT 1; SELECT 2; SELECT 3;");
    expect(stmts.map((s) => s.trim())).toEqual(["SELECT 1;", "SELECT 2;", "SELECT 3;"]);
  });

  test("respects BEGIN…END trigger bodies", () => {
    const sql = `
      CREATE TRIGGER t AFTER INSERT ON x BEGIN
        INSERT INTO y VALUES (1);
        INSERT INTO z VALUES (2);
      END;
      CREATE INDEX i ON x(c);
    `;
    const stmts = splitSqlStatements(sql)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE TRIGGER");
    expect(stmts[0]).toContain("END;");
    expect(stmts[1]).toContain("CREATE INDEX");
  });

  test("strips -- line comments before splitting", () => {
    const sql = `
      -- top comment with ; in it
      SELECT 1; -- trailing comment with ;
      SELECT 2;
    `;
    const stmts = splitSqlStatements(sql)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(stmts).toHaveLength(2);
  });

  test("respects doubled-quote escapes inside string literals", () => {
    // 'it''s' is one literal containing an apostrophe. A naive splitter
    // would treat the first `'` of `''` as closing the string and then
    // see `; SELECT 2` as a top-level boundary inside what it thinks is
    // a freshly-opened string.
    const sql = "INSERT INTO t (s) VALUES ('it''s; fine'); SELECT 2;";
    const stmts = splitSqlStatements(sql)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'it''s; fine'");
    expect(stmts[1]).toBe("SELECT 2;");
  });

  test("respects doubled-quote escapes inside double-quoted identifiers", () => {
    const sql = `CREATE TABLE "weird""name" (id INT); SELECT 1;`;
    const stmts = splitSqlStatements(sql)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain(`"weird""name"`);
  });
});
