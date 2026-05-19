import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ensureExtensionCapableSqlite,
  getConfig,
  openArchive,
  setConfig,
} from "../src/archive/open.ts";
import { queryAll, queryOne } from "./helpers.ts";

const NameRowSchema = z.object({ name: z.string() });
const FolderRowSchema = z.object({ folder_name: z.string() });
const VecResultSchema = z.object({ folder_name: z.string(), d: z.number() });

function makeArchivePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "swrag-archive-test-"));
  return join(dir, "swrag.sqlite");
}

describe("openArchive", () => {
  test("creates the schema and config on first open", () => {
    const path = makeArchivePath();
    const db = openArchive(path);
    try {
      const rows = queryAll(
        db,
        NameRowSchema,
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
      );
      const names = rows.map((r) => r.name);
      expect(names).toContain("recording");
      expect(names).toContain("recording_fts");
      expect(names).toContain("recording_vec");
      expect(names).toContain("config");
      expect(names).toContain("v_search");
      // Schema version lives in PRAGMA user_version (not the config table).
      const userVersion = queryOne(
        db,
        z.object({ user_version: z.number() }),
        "PRAGMA user_version",
      );
      expect(userVersion.user_version).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      rmSync(path);
    }
  });

  test("setConfig / getConfig roundtrip", () => {
    const path = makeArchivePath();
    const db = openArchive(path);
    try {
      setConfig(db, "foo", "bar");
      expect(getConfig(db, "foo")).toBe("bar");
      setConfig(db, "foo", "baz");
      expect(getConfig(db, "foo")).toBe("baz");
    } finally {
      db.close();
    }
  });

  test("append-only trigger blocks DELETE FROM recording", () => {
    const path = makeArchivePath();
    const db = openArchive(path);
    try {
      db.exec(
        "INSERT INTO recording (folder_name, recording_id_hex, datetime, duration_ms, mode_name, indexed_at, meta_path) " +
          "VALUES ('f1', 'aa', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00', '/tmp/m.json')",
      );
      expect(() =>
        db.exec("DELETE FROM recording WHERE folder_name = 'f1'"),
      ).toThrow(/append-only/);
      expect(() =>
        db.exec(
          "UPDATE recording SET source_deleted_at = '2026-01-02' WHERE folder_name = 'f1'",
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("FTS5 is populated by triggers", () => {
    const path = makeArchivePath();
    const db = openArchive(path);
    try {
      db.exec(
        "INSERT INTO recording (folder_name, recording_id_hex, datetime, duration_ms, mode_name, " +
          "llm_result, indexed_at, meta_path) " +
          "VALUES ('f2', 'bb', '2026-01-01T00:00:00', 1000, 'Universal', 'hello bullmq world', '2026-01-01T00:00:00', '/tmp/m.json')",
      );
      const matches = queryAll(
        db,
        FolderRowSchema,
        "SELECT folder_name FROM recording_fts WHERE recording_fts MATCH 'bullmq'",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.folder_name).toBe("f2");
    } finally {
      db.close();
    }
  });

  test("sqlite-vec loaded and recording_vec usable", () => {
    const path = makeArchivePath();
    const db = openArchive(path);
    try {
      const ext = ensureExtensionCapableSqlite();
      expect(ext.dylib).not.toBeNull();
      const v = new Float32Array(1024);
      v[0] = 1;
      db.prepare(
        "INSERT INTO recording_vec (folder_name, embedding) VALUES (?, ?)",
      ).run("vec-test", v);
      const r = queryOne(
        db,
        VecResultSchema,
        "SELECT folder_name, vec_distance_cosine(embedding, :q) AS d FROM recording_vec",
        { ":q": v },
      );
      expect(r.folder_name).toBe("vec-test");
      expect(r.d).toBeLessThan(0.001);
    } finally {
      db.close();
    }
  });

  test("readonly open of nonexistent archive throws", () => {
    expect(() =>
      openArchive("/nonexistent/swrag.sqlite", { readonly: true }),
    ).toThrow(/does not exist/);
  });
});
