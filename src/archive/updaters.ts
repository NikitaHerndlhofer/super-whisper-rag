/**
 * Data updaters applied in version order on every `ensureFresh`.
 *
 * Parallel to `MIGRATIONS` but for *data / computed-state* transitions
 * — things that can't be expressed as SQL DDL because they involve
 * network I/O (calling Ollama), reading `meta.json` from disk, or
 * invoking sub-pipelines (the chunker). Tracked by a `data_version`
 * row in `config` (parallel to `PRAGMA user_version`).
 *
 * Add a new updater by:
 *
 *   1. Dropping a file `src/archive/updaters/NNN_short_name.ts` that
 *      exports an async `(archive, opts) => Promise<void>` function.
 *   2. Importing it here and appending an entry to `UPDATERS`.
 *
 * Pair updaters with the migration whose new state they backfill — by
 * convention the `version` integer matches. Never edit a shipped
 * updater; instead, add a new one at the next version that corrects
 * whatever was wrong.
 */
import type { Database } from "bun:sqlite";
import type { IngestOptions } from "../ingest/ingester.ts";
import { backfillChunks } from "./updaters/004_backfill_chunks.ts";
import { v09Marker } from "./updaters/005_v09_marker.ts";
import { v11Marker } from "./updaters/006_v11_marker.ts";

export interface Updater {
  /** Strictly increasing integer. By convention, matches the migration version it pairs with. */
  version: number;
  /** Short human-readable name. */
  name: string;
  /**
   * Runs OUTSIDE a transaction (may do network I/O, call sub-pipelines, etc.).
   * Receives the same IngestOptions as ensureFresh so it can call embedBatch,
   * readMetaContext, etc. Updaters can open their own internal transactions
   * for local writes.
   */
  fn(archive: Database, opts: IngestOptions): Promise<void>;
}

export const UPDATERS: readonly Updater[] = [
  { version: 4, name: "backfill_chunks", fn: backfillChunks },
  { version: 5, name: "v09_marker", fn: v09Marker },
  { version: 6, name: "v11_marker", fn: v11Marker },
];

/** Latest data version known to this binary. */
export const LATEST_DATA_VERSION: number = Math.max(...UPDATERS.map((u) => u.version));
