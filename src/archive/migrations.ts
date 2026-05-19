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
 * Never edit an existing migration — published archives are running it.
 * Need a fix? Add a new migration that corrects the state.
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
];

/** Latest version known to this binary. */
export const LATEST_VERSION: number = Math.max(...MIGRATIONS.map((m) => m.version));
