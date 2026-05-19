import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runSql } from "../src/commands/sql.ts";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { makeEnv, stubEmbed, type TestEnv } from "./helpers.ts";

let env: TestEnv;

const baseSqlOpts = () => ({
  archive: env.archive,
  sourceDb: env.sourceDb,
  sourceDir: env.sourceDir,
  embedModel: "test-model",
  ollamaHost: "http://127.0.0.1:0",
});

beforeEach(async () => {
  env = makeEnv();
  await ensureFresh({
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  });
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

describe("swrag sql (pure sqlite3 passthrough)", () => {
  test("plain SELECT returns sqlite3 list-mode output", async () => {
    const r = await runSql({
      ...baseSqlOpts(),
      sql: "SELECT folder_name FROM recording ORDER BY datetime ASC LIMIT 1",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    // single-column list mode → no pipe separators
    expect(r.stdout).not.toContain("|");
  });

  test("multi-column list mode uses pipe separators (sqlite3 default)", async () => {
    const r = await runSql({
      ...baseSqlOpts(),
      sql: "SELECT folder_name, mode_name FROM recording ORDER BY datetime ASC LIMIT 1",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("|");
  });

  test("FTS5 MATCH with an inlined literal value works", async () => {
    const r = await runSql({
      ...baseSqlOpts(),
      sql:
        "SELECT r.folder_name FROM recording_fts " +
        "JOIN recording r ON r.rowid = recording_fts.rowid " +
        "WHERE recording_fts MATCH 'bullmq'",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  test("writes to the archive fail with sqlite3's read-only error", async () => {
    const r = await runSql({
      ...baseSqlOpts(),
      sql: "DELETE FROM recording",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/readonly|read-only|read only/i);
  });

  // Note: REPL behaviour (`sql == null`) is exercised manually — the
  // interactive sqlite3 inherits stdin/stdout, which hangs in a non-TTY
  // test runner.
});
