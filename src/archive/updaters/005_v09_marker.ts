/**
 * v1.0 data-version marker.
 *
 * The v0.9 → v1.0 cleanup (drop `meeting_queue`, delete meeting-pipeline
 * config rows) is entirely schema-level — see migration 005 — because
 * the data layer has nothing to compute or backfill. This updater
 * exists purely as a `data_version` waypoint:
 *
 *   - Without it, `LATEST_DATA_VERSION` would stay at 4 and post-upgrade
 *     archives would report "data_version 4 (matches binary)" forever.
 *     That's not wrong, but it loses the per-release diagnostic signal:
 *     when a user reports a bug we want to read `data_version` and know
 *     which binary first touched their archive.
 *   - The runner only writes `data_version` when `applied.length > 0`,
 *     so a no-op updater that always advances cleanly is the cheapest
 *     way to bump the bookmark without breaking the "fail → retry"
 *     guarantee for real updaters.
 *
 * Idempotent by construction (does nothing). Defensive against the
 * (impossible) case where migration 005 hasn't run yet: it doesn't
 * touch `meeting_queue` so any state there is irrelevant.
 */
import type { Database } from "bun:sqlite";
import type { IngestOptions } from "../../ingest/ingester.ts";

export async function v09Marker(_archive: Database, _opts: IngestOptions): Promise<void> {
  // Intentionally empty. See module docstring.
}
