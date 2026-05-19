import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { EMBED_DIM } from "../config.ts";
import { getEnv } from "../env.ts";
import { BREW_SQLITE_PATHS } from "../paths.ts";
import { runMigrations } from "./migrate.ts";
import { vecDylibPath } from "./vec-loader.ts";

let appliedDylib: string | null = null;
let customSqliteFailed = false;

/**
 * Configure bun:sqlite to use a build that supports loadable extensions.
 *
 * Bun ships Apple's system SQLite on macOS, which disables extensions, so
 * sqlite-vec can't load against it. We point at Homebrew's vanilla SQLite
 * when available.
 *
 * `setCustomSQLite` can only run once per process; subsequent calls throw.
 * We treat that as success and remember the path we installed.
 */
export function ensureExtensionCapableSqlite(): { dylib: string | null } {
  if (appliedDylib != null) return { dylib: appliedDylib };
  if (customSqliteFailed) return { dylib: null };
  const envPath = getEnv().SWRAG_SQLITE_DYLIB;
  const candidates = envPath ? [envPath, ...BREW_SQLITE_PATHS] : [...BREW_SQLITE_PATHS];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        Database.setCustomSQLite(p);
      } catch {
        // Already applied earlier in this process.
      }
      appliedDylib = p;
      return { dylib: p };
    }
  }
  customSqliteFailed = true;
  return { dylib: null };
}

export interface OpenOptions {
  /** Open in read-only mode. */
  readonly?: boolean;
  /** Skip sqlite-vec loading (for tests / commands that don't need vec). */
  skipVec?: boolean;
}

/**
 * Open the archive. For read-write opens, runs pending schema migrations
 * (tracked via `PRAGMA user_version`) and seeds `config` defaults. For
 * read-only opens, fails if the archive doesn't yet exist (so the caller
 * knows to run ingest first).
 */
export function openArchive(path: string, options: OpenOptions = {}): Database {
  const readonly = !!options.readonly;
  ensureExtensionCapableSqlite();

  if (!readonly) {
    mkdirSync(dirname(path), { recursive: true });
  } else if (!existsSync(path)) {
    throw new Error(`archive does not exist: ${path}`);
  }

  const db = readonly
    ? new Database(path, { readonly: true })
    : new Database(path, { create: true, readwrite: true });

  if (!options.skipVec) {
    // The dylib exports `sqlite3_vec_init`. We pass it explicitly because
    // SQLite would otherwise derive the entry point from the file name
    // (`vec0-darwin-arm64.dylib` -> `sqlite3_vec0darwinarm64_init`).
    db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
  }

  if (!readonly) {
    runMigrations(db);
    initialiseConfig(db);
  }

  return db;
}

/**
 * Open the archive, hand the connection to `fn`, and close it on the way
 * out — including when `fn` throws. Centralises the
 *
 *   const db = openArchive(...); try { … } finally { db.close(); }
 *
 * pattern that previously appeared at every callsite. Async-aware.
 */
export async function withArchive<T>(
  path: string,
  options: OpenOptions,
  fn: (db: Database) => T | Promise<T>,
): Promise<T> {
  const db = openArchive(path, options);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

const INITIAL_CONFIG: Record<string, string> = {
  embed_dim: String(EMBED_DIM),
};

function initialiseConfig(db: Database): void {
  const insert = db.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(INITIAL_CONFIG)) {
    insert.run(key, value);
  }
}

const ConfigRowSchema = z.object({ value: z.string() });

export function getConfig(db: Database, key: string): string | undefined {
  const raw: unknown = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
  if (raw == null) return undefined;
  return ConfigRowSchema.parse(raw).value;
}

export function setConfig(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
