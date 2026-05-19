import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runSql } from "../src/commands/sql.ts";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { makeEnv, stubEmbed, type TestEnv } from "./helpers.ts";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

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

  test("`-- -json …` passthrough switches sqlite3 to JSON output", async () => {
    const r = await runSql({
      ...baseSqlOpts(),
      sql: null,
      extraArgs: ["-json", "SELECT 'a' AS x, 'b' AS y"],
    });
    expect(r.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as { x: string; y: string }[])[0]).toEqual({ x: "a", y: "b" });
  });

  test("`-- -cmd '.mode markdown' …` passthrough switches to markdown", async () => {
    const r = await runSql({
      ...baseSqlOpts(),
      sql: null,
      extraArgs: ["-cmd", ".mode markdown", "SELECT 'a' AS x, 'b' AS y"],
    });
    expect(r.exitCode).toBe(0);
    // markdown mode emits a `| col | col |` table header
    expect(r.stdout).toContain("| x | y |");
  });

  test("passthrough also works with a user `-cmd` that runs before the SQL", async () => {
    const r = await runSql({
      ...baseSqlOpts(),
      sql: null,
      extraArgs: ["-cmd", ".parameter set :app 'Cursor'", "SELECT :app AS app"],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("Cursor");
  });

  // Note: REPL behaviour (`sql == null`, no passthrough) is exercised
  // manually — the interactive sqlite3 inherits stdin/stdout, which
  // hangs in a non-TTY test runner.
});

/**
 * These tests drive the full citty entry point as a child process,
 * because the conflict-detection that lives in `cli.ts` (inline-SQL +
 * `--` passthrough) is not exercised by calling `runSql` directly —
 * it depends on `process.argv` shape. Subprocess overhead is fine for
 * a handful of cases.
 */
describe("swrag sql -- conflict detection (subprocess)", () => {
  function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const r = Bun.spawnSync({
      cmd: ["bun", "run", CLI_ENTRY, ...args],
      env: {
        ...process.env,
        SWRAG_SOURCE_DB: env.sourceDb,
        SWRAG_SOURCE_DIR: env.sourceDir,
        SWRAG_ARCHIVE: env.archive,
        SWRAG_SKIP_EMBED: "1",
        SWRAG_QUIET: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: r.exitCode ?? 1,
      stdout: r.stdout ? new TextDecoder().decode(r.stdout) : "",
      stderr: r.stderr ? new TextDecoder().decode(r.stderr) : "",
    };
  }

  test("sql after `--` alone is fine — citty's positional capture must not falsely trigger the conflict", () => {
    const r = runCli(["sql", "--", "-json", "SELECT 'ok' AS x"]);
    expect(r.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(r.stdout);
    expect((parsed as { x: string }[])[0]).toEqual({ x: "ok" });
  });

  test("inline sql alone is fine", () => {
    const r = runCli(["sql", "SELECT 'inline' AS x"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("inline");
  });

  test("inline SQL combined with `--` passthrough errors out", () => {
    const r = runCli(["sql", "SELECT 1", "--", "-json", "SELECT 'tail' AS x"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/cannot combine inline SQL.*--.*passthrough/);
  });
});
