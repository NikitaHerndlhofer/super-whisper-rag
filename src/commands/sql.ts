import { ensureFresh } from "../ingest/ingester.ts";
import { verbose } from "../log.ts";
import {
  execSqlite3Interactive,
  runSqlite3,
  type Sqlite3Result,
} from "../sqlite3.ts";

/**
 * Run a SQL query against the archive by exec'ing the sqlite3 CLI.
 *
 * This is a deliberately thin passthrough. We do exactly four things:
 *
 *   1. mtime-fast-path ingest from Super Whisper (sub-ms when nothing changed).
 *   2. Open the archive read-only via `file:…?mode=ro`.
 *   3. `-cmd ".load <vec0_path> sqlite3_vec_init"` so vector search works.
 *   4. Hand the user's SQL to sqlite3 and forward its stdout/stderr/exit.
 *
 * Output is sqlite3's default (list mode, pipe-separated, no header). If
 * you need anything else — JSON, CSV, named-parameter binding, dot-commands
 * — run `sqlite3` directly:
 *
 *   sqlite3 "$(swrag path)" -cmd ".load $(swrag path vec0) sqlite3_vec_init" …
 *
 * For semantic search, compose with `swrag embed`:
 *
 *   swrag sql "SELECT folder_name
 *              FROM recording_vec
 *              ORDER BY vec_distance_cosine(embedding, $(swrag embed 'hello'))
 *              LIMIT 5"
 */
export interface RunSqlOptions {
  /** SQL to execute. `null` or empty drops into the sqlite3 REPL. */
  sql: string | null;
  archive: string;
  sourceDb: string;
  sourceDir: string;
  embedModel: string;
  ollamaHost: string;
}

/** Read SQL from stdin or use the inline argument. */
export async function readSqlInput(
  inline: string | null,
  fromStdin: boolean,
): Promise<string | null> {
  if (fromStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return inline;
}

export async function runSql(opts: RunSqlOptions): Promise<Sqlite3Result> {
  try {
    await ensureFresh({
      sourceDb: opts.sourceDb,
      sourceDir: opts.sourceDir,
      archive: opts.archive,
      embedModel: opts.embedModel,
      ollamaHost: opts.ollamaHost,
    });
  } catch (e) {
    verbose(`gap-fill ingest skipped: ${errorMessage(e)}`);
  }

  const trimmed = (opts.sql ?? "").trim();
  if (trimmed.length === 0) {
    const code = execSqlite3Interactive({
      archive: opts.archive,
      sql: null,
      readonly: true,
    });
    return { exitCode: code, stdout: "", stderr: "" };
  }

  return runSqlite3({
    archive: opts.archive,
    sql: trimmed,
    readonly: true,
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
