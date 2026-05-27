/**
 * v1.1 data-version marker.
 *
 * The v1.1.0 schema work (migration 006) is entirely schema-level —
 * virtual generated columns + FTS rebuild + the long-overdue
 * v0.9 cleanup — with no data layer to backfill. This updater exists
 * purely as a `data_version` waypoint so post-upgrade `swrag doctor`
 * output cleanly reports "data_version 6 (matches binary)" and so
 * any user we triage in the future has a per-release fingerprint.
 *
 * Idempotent by construction (does nothing). Mirrors the role of
 * `005_v09_marker.ts`; see its docstring for the broader rationale
 * on no-op updaters as version waypoints.
 */
import type { Database } from "bun:sqlite";
import type { IngestOptions } from "../../ingest/ingester.ts";

export async function v11Marker(_archive: Database, _opts: IngestOptions): Promise<void> {
  // Intentionally empty. See module docstring.
}
