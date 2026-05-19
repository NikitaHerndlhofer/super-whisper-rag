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
import { run } from "./spawn.ts";

export interface Sqlite3Options {
  archive: string;
  /** SQL to execute. When null/empty, the caller wants the REPL. */
  sql: string | null;
  /** Open read-only (default true). */
  readonly: boolean;
  /**
   * Extra arguments forwarded to sqlite3 verbatim, slotted between our
   * setup (`-bail`, `-cmd ".load …"`) and the archive URI. Used to
   * implement `swrag sql -- <sqlite3 args>` passthrough. May contain
   * sqlite3 flags (-json, -box, -cmd "…") and/or the user's SQL.
   *
   * When `extraArgs` is non-empty, `sql` should be `null` — the caller's
   * SQL travels inside `extraArgs`.
   */
  extraArgs?: string[];
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
  return run([findSqlite3Binary(), ...buildArgs(opts)]);
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
  // Order matters: sqlite3 consumes the first non-flag positional as
  // DATABASE and the second as SQL. The archive URI MUST appear before
  // the user's passthrough so it gets the DATABASE slot — otherwise a
  // user passing `[..., -json, "SELECT 1"]` would have "SELECT 1"
  // treated as DATABASE and the URI as SQL.
  const args: string[] = [
    "-bail",
    "-cmd",
    `.load ${quoteForDotCmd(vecDylibPath())} sqlite3_vec_init`,
    uriFor(opts.archive, opts.readonly),
  ];
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }
  if (opts.sql && opts.sql.trim().length > 0) {
    args.push(opts.sql);
  }
  return args;
}

function uriFor(path: string, readonly: boolean): string {
  return readonly ? `file:${path}?mode=ro` : path;
}

function quoteForDotCmd(path: string): string {
  // sqlite3's `.load` parser is whitespace-delimited with simple quote
  // handling — no escape sequences inside quoted strings. The materialised
  // vec0 dylib path is always `${tmpdir}/swrag-vec0-<sanitised-user>/…` and
  // `safeUsername()` strips non-`[A-Za-z0-9_-]`, so a `'` cannot appear in
  // the path we pass through here. Assert that loudly rather than pretend
  // to handle a case sqlite3 can't represent.
  if (path.includes("'")) {
    throw new Error(`dylib path contains a single quote, cannot be loaded: ${path}`);
  }
  return `'${path}'`;
}
