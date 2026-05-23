import { join } from "node:path";
import {
  applyRecordingUpsert,
  embedDirtyRows,
  ensureFresh,
  hashNewAudioFiles,
  RECORDING_UPSERT_SQL,
  refreshSupersedence,
  type IngestResult,
} from "../ingest/ingester.ts";
import { readMetaContext, readSourceRecordingByFolder } from "../ingest/sources.ts";
import { withArchive } from "../archive/open.ts";
import { info, verbose } from "../log.ts";
import { refreshInstalledSkills } from "./install-skill.ts";

export interface IndexCommandOptions {
  sourceDir: string;
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
  skipEmbeddings?: boolean;
}

export async function runIndex(opts: IndexCommandOptions): Promise<IngestResult> {
  const result = await ensureFresh({
    sourceDb: opts.sourceDb,
    sourceDir: opts.sourceDir,
    archive: opts.archive,
    embedModel: opts.embedModel,
    ollamaHost: opts.ollamaHost,
    skipEmbeddings: opts.skipEmbeddings,
  });
  if (result.fastPath) {
    info("source unchanged; nothing to do");
  } else {
    info(
      `ingested ${result.newRows} new, ${result.updatedRows} updated, ${result.embedded} embedded, ` +
        `${result.sourceDeletions} marked deleted, ${result.audioChanges} audio changes ` +
        `(${result.durationMs} ms)`,
    );
  }

  // Auto-upgrade hook: if the user has installed skills and the bundled
  // SKILL.md has changed (e.g. because they just `brew upgrade`d), refresh
  // the on-disk copies in place — but only when the user hasn't edited
  // them since we last wrote (see install-skill.ts for the rules).
  // Best-effort; failures are logged at verbose level only — never
  // blocking ingest.
  try {
    const refreshed = (await refreshInstalledSkills(opts.archive)).filter((r) => r.refreshed);
    if (refreshed.length > 0) {
      info(`refreshed ${refreshed.length} skill file(s) to match the new binary`);
      for (const r of refreshed) verbose(`  ${r.path}`);
    }
  } catch (e) {
    verbose(`skill auto-refresh skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}

export interface IndexFolderOptions {
  folderName: string;
  sourceDir: string;
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
  skipEmbeddings?: boolean;
  /** For tests: bypass Ollama and produce deterministic vectors. */
  embedFn?: (texts: string[]) => Promise<Float32Array[]>;
}

export interface IndexFolderResult {
  folderName: string;
  /** True if the upsert hit an existing archive row, false on first insert. */
  existed: boolean;
  /** Number of rows the embed pass actually processed (0 if `skipEmbeddings`). */
  embedded: number;
  /** Number of supersedence transitions caused by this run. */
  superseded: number;
  /** Total elapsed wall time in milliseconds. */
  durationMs: number;
}

/**
 * Targeted, single-folder ingest. Reads one row from SW's DB by
 * `folderName`, enriches with `meta.json`, upserts into the archive,
 * runs the audio-hash + supersedence + embed pipeline, and writes
 * nothing to `last_indexed_datetime`.
 *
 * **Why this exists**: the bulk `ensureFresh` path filters
 * `WHERE r.datetime > last_indexed_datetime`. Rows whose `datetime`
 * the patcher has rewritten into the past are silently skipped by
 * that path (§1.1 bug confirmed in `docs/sw-patcher-spike.md`). After
 * patching SW's row, the processor calls this function so the archive
 * picks up the patched row regardless of `last_indexed_datetime`.
 *
 * Crucially we do NOT touch `last_indexed_datetime` here — that would
 * break the next bulk run for legitimately new (un-patched) SW rows.
 */
export async function runIndexFolder(opts: IndexFolderOptions): Promise<IndexFolderResult> {
  const t0 = Date.now();
  const sourceRow = readSourceRecordingByFolder(opts.sourceDb, opts.folderName);
  if (!sourceRow) {
    throw new Error(
      `runIndexFolder: SW DB has no row for folderName=${opts.folderName} (DB=${opts.sourceDb})`,
    );
  }
  const recordingsDir = join(opts.sourceDir, "recordings");
  const meta = await readMetaContext(recordingsDir, opts.folderName);

  return withArchive(opts.archive, {}, async (archive) => {
    const nowIso = new Date().toISOString();
    const upsertStmt = archive.prepare(RECORDING_UPSERT_SQL);
    const existsStmt = archive.prepare("SELECT folder_name FROM recording WHERE folder_name = ?");

    let existed = false;
    const tx = archive.transaction(() => {
      const outcome = applyRecordingUpsert(upsertStmt, existsStmt, sourceRow, meta, nowIso);
      existed = outcome.existed;
    });
    tx();

    await hashNewAudioFiles(archive);
    const superseded = refreshSupersedence(archive, nowIso);

    let embedded = 0;
    if (!opts.skipEmbeddings) {
      embedded = await embedDirtyRows(archive, {
        model: opts.embedModel,
        host: opts.ollamaHost,
        fn: opts.embedFn,
      });
    }

    verbose(
      `runIndexFolder(${opts.folderName}): ${existed ? "updated" : "inserted"}; ` +
        `${embedded} embedded; ${superseded} supersedence transitions`,
    );

    return {
      folderName: opts.folderName,
      existed,
      embedded,
      superseded,
      durationMs: Date.now() - t0,
    };
  });
}
