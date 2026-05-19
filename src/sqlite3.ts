/**
 * Thin wrapper around the `sqlite3` CLI.
 *
 * `swrag sql` is a passthrough to this binary, with two additions:
 *   1. The archive is opened via a `file:…?mode=ro` URI so writes are
 *      refused at the connection level.
 *   2. sqlite-vec is loaded via `-cmd ".load <vec0_path> sqlite3_vec_init"`.
 *
 * Output formatting, named-parameter binding, dot-commands — anything
 * beyond loading the extension and pointing at the archive — is whatever
 * sqlite3 itself does. We do not reimplement any of it.
 *
 * Users who need more (custom output modes, .parameter set, etc.) should
 * call sqlite3 directly via `swrag path` rather than asking us to grow
 * flags.
 */
import { existsSync } from "node:fs";
import { vecDylibPath } from "./archive/vec-loader.ts";
import { BREW_SQLITE_BIN_PATHS } from "./paths.ts";

export interface Sqlite3Options {
  archive: string;
  /** SQL to execute. When null/empty, the caller wants the REPL. */
  sql: string | null;
  /** Open read-only (default true). */
  readonly: boolean;
}

export interface Sqlite3Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Locate a sqlite3 binary that supports loadable extensions. */
export function findSqlite3Binary(): string {
  for (const p of BREW_SQLITE_BIN_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "sqlite3 not found (need a build with loadable extensions). Install with: brew install sqlite",
  );
}

/**
 * Execute a query through the sqlite3 CLI. stdout / stderr are captured;
 * the caller is responsible for forwarding them. For interactive use see
 * `execSqlite3Interactive`.
 */
export function runSqlite3(opts: Sqlite3Options): Sqlite3Result {
  const args = buildArgs(opts);
  const r = Bun.spawnSync({
    cmd: [findSqlite3Binary(), ...args],
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

/**
 * Exec into sqlite3 with the current process's stdio. Used for the REPL
 * path (`swrag sql` with no query).
 */
export function execSqlite3Interactive(opts: Sqlite3Options): number {
  const args = buildArgs(opts);
  const r = Bun.spawnSync({
    cmd: [findSqlite3Binary(), ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return r.exitCode ?? 1;
}

function buildArgs(opts: Sqlite3Options): string[] {
  const args: string[] = [
    "-bail",
    "-cmd",
    `.load ${quoteForDotCmd(vecDylibPath())} sqlite3_vec_init`,
    uriFor(opts.archive, opts.readonly),
  ];
  if (opts.sql && opts.sql.trim().length > 0) {
    args.push(opts.sql);
  }
  return args;
}

function uriFor(path: string, readonly: boolean): string {
  return readonly ? `file:${path}?mode=ro` : path;
}

function quoteForDotCmd(path: string): string {
  // sqlite3's `.load` parser is whitespace-delimited with quote handling.
  // We single-quote the path and escape any embedded single quotes.
  return `'${path.replace(/'/g, "'\\''")}'`;
}
