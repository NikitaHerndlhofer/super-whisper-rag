import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  ensureExtensionCapableSqlite,
  openArchive,
} from "../src/archive/open.ts";
import { runMigrations, splitSqlStatements } from "../src/archive/migrate.ts";
import { LATEST_VERSION, MIGRATIONS } from "../src/archive/migrations.ts";
import { vecDylibPath } from "../src/archive/vec-loader.ts";
import { queryOne } from "./helpers.ts";
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
      expect(
        queryOne(db, UserVersionRowSchema, "PRAGMA user_version").user_version,
      ).toBe(0);

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
      expect(
        queryOne(db, UserVersionRowSchema, "PRAGMA user_version").user_version,
      ).toBe(LATEST_VERSION);
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

describe("splitSqlStatements", () => {
  test("splits on top-level semicolons", () => {
    const stmts = splitSqlStatements("SELECT 1; SELECT 2; SELECT 3;");
    expect(stmts.map((s) => s.trim())).toEqual([
      "SELECT 1;",
      "SELECT 2;",
      "SELECT 3;",
    ]);
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
});
