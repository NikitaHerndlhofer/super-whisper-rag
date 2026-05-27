/**
 * Schema migrations applied in version order on every archive open.
 *
 * Add a new migration by:
 *
 *   1. Dropping a file `src/archive/migrations/NNN_short_name.sql` where
 *      `NNN` is the next integer (`003`, `004`, …).
 *   2. Importing it here with `with { type: "text" }`.
 *   3. Appending a row to `MIGRATIONS` with the new version + name + sql.
 *
 * NEVER edit an existing migration — published archives are running it.
 * NEVER reuse a version number for a different file. The runner skips
 * any migration whose version <= the archive's current `PRAGMA
 * user_version`, so a redefined "version 5" would silently never run
 * on an archive that already has user_version >= 5. (We learned this
 * the hard way: v0.7.0 shipped `005_meeting_queue.sql` and v1.0.0
 * replaced it with `005_cleanup_v09.sql`. v1.1.0's migration 006
 * re-runs the missed cleanup. `tests/migrations.test.ts` freezes
 * the sha256 of every shipped migration to catch a repeat at CI
 * time.) Need a fix? Add a new migration that corrects the state.
 *
 * The runner (`runMigrations` in `./migrate.ts`) reads SQLite's
 * `PRAGMA user_version`, applies anything strictly greater than it, and
 * bumps `user_version` inside the same transaction.
 *
 * Bun's `with { type: "text" }` import inlines the file content at build
 * time, so these strings travel inside the compiled binary — no runtime
 * filesystem reads.
 */
import init from "./migrations/001_init.sql" with { type: "text" };
import audioHashSupersedence from "./migrations/002_audio_hash_supersedence.sql" with {
  type: "text",
};
import ftsTriggerPartialIndex from "./migrations/003_fts_trigger_partial_index.sql" with {
  type: "text",
};
import chunks from "./migrations/004_chunks.sql" with { type: "text" };
import cleanupV09 from "./migrations/005_cleanup_v09.sql" with { type: "text" };
import transcriptSchema from "./migrations/006_transcript_schema.sql" with {
  type: "text",
};

export interface Migration {
  /** Strictly increasing integer; matches the file name prefix. */
  version: number;
  /** Short human-readable name. */
  name: string;
  /** SQL body (may contain many statements; runner splits & runs each). */
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", sql: init },
  { version: 2, name: "audio_hash_supersedence", sql: audioHashSupersedence },
  { version: 3, name: "fts_trigger_partial_index", sql: ftsTriggerPartialIndex },
  { version: 4, name: "chunks", sql: chunks },
  { version: 5, name: "cleanup_v09", sql: cleanupV09 },
  { version: 6, name: "transcript_schema", sql: transcriptSchema },
];

/** Latest version known to this binary. */
export const LATEST_VERSION: number = Math.max(...MIGRATIONS.map((m) => m.version));
