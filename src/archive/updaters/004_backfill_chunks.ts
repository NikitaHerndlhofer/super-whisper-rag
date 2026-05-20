/**
 * Updater 4 — paired with migration 004 (chunks).
 *
 * The body is intentionally empty. Its only purpose is to *exist*, which
 * forces `ensureFresh` off its mtime fast-path on the first launch under
 * the new binary (see `runUpdaters` wiring in `src/ingest/ingester.ts`).
 * Once on the slow path, `embedDirtyRows`' existing
 * "long row missing chunks" dirty-detection rule does the actual
 * backfill — we don't want to duplicate that logic here.
 *
 * Concretely: after a `brew upgrade` from a pre-chunking build to a
 * chunking-aware one, the user has long rows in `recording` with valid
 * whole-document embeddings but no `recording_chunk` rows. Without this
 * updater, the launchd-driven `ensureFresh` would early-return on every
 * tick (source DB mtime unchanged + embed model unchanged) and never
 * notice. With this updater, `data_version` is missing from `config`,
 * so the runner schedules updater 4 → `updatersRan` flips true →
 * fast-path is vetoed → the slow path runs → chunks get backfilled.
 *
 * The defensive assertion below catches the impossible-but-cheap-to-rule-
 * out case where someone manages to set `data_version < 4` on an archive
 * whose migration runner did not create the chunk tables (e.g. a
 * malformed external write to `config`).
 */
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { IngestOptions } from "../../ingest/ingester.ts";

const TableCountSchema = z.object({ n: z.number().int() });

export async function backfillChunks(
  archive: Database,
  _opts: IngestOptions,
): Promise<void> {
  const raw: unknown = archive
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'recording_chunk'",
    )
    .get();
  const has = TableCountSchema.parse(raw).n > 0;
  if (!has) {
    throw new Error(
      "updater 4 (backfill_chunks): recording_chunk table missing — migration 004 did not run",
    );
  }
}
