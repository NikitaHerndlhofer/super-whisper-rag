import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { EMBED_BATCH_SIZE } from "../config.ts";
import { embedBatch } from "../embed/ollama.ts";
import { info, verbose } from "../log.ts";
import { getConfig, setConfig, withArchive } from "../archive/open.ts";
import { runUpdaters } from "../archive/update.ts";
import {
  chunkSourceBody,
  chunkText,
  DEFAULT_CHUNK_STRATEGY,
  serializeChunkStrategy,
  wordCountForChunking,
  type Chunk,
} from "./chunker.ts";
import {
  readMetaContext,
  readSourceFolderNames,
  readSourceRecordings,
  sourceDbMtimeNs,
  type MetaContext,
  type SourceRecording,
} from "./sources.ts";
import { snapshotSourceDb } from "./snapshot.ts";
import { markSourceDeletions, refreshAudioLiveness } from "./deletions.ts";

const DirtyRowSchema = z.object({
  folder_name: z.string(),
  mode_name: z.string(),
  llm_result: z.string().nullable(),
  raw_result: z.string().nullable(),
  llm_word_count: z.number().nullable(),
  raw_word_count: z.number().nullable(),
  embed_text_hash: z.string().nullable(),
  embed_model: z.string().nullable(),
});
type DirtyRow = z.infer<typeof DirtyRowSchema>;

const VecFolderRowSchema = z.object({ folder_name: z.string() });
const ChunkFolderRowSchema = z.object({ folder_name: z.string() });

const ExistingChunkRowSchema = z.object({
  id: z.number().int(),
  chunk_idx: z.number().int(),
  text: z.string(),
  start_word: z.number().int(),
  end_word: z.number().int(),
  word_count: z.number().int(),
});
type ExistingChunkRow = z.infer<typeof ExistingChunkRowSchema>;

const ExistsRowSchema = z.object({ folder_name: z.string() });

const AudioHashRowSchema = z.object({
  folder_name: z.string(),
  audio_path: z.string().nullable(),
});

const SupersedenceRowSchema = z.object({
  folder_name: z.string(),
  audio_hash: z.string(),
  datetime: z.string(),
});

export interface IngestOptions {
  sourceDir: string;
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
  /** When true, skip the embedding pass entirely (text-only ingestion). */
  skipEmbeddings?: boolean;
  /** When set, use this function instead of calling Ollama. For tests. */
  embedFn?: (texts: string[]) => Promise<Float32Array[]>;
}

export interface IngestResult {
  fastPath: boolean;
  newRows: number;
  updatedRows: number;
  embedded: number;
  sourceDeletions: number;
  audioChanges: number;
  modelSwitched: boolean;
  durationMs: number;
}

/**
 * Single source of truth for the recording-upsert SQL. Used by both the
 * bulk `ensureFresh` path and the per-folder `runIndexFolder` path so
 * the two stay column-for-column identical without copy-paste.
 *
 * `language`, `app_name`, and `app_category` are COALESCEd on update to
 * preserve previously-enriched values when SW reprocesses a row without
 * a fresh meta.json.
 */
export const RECORDING_UPSERT_SQL = `
  INSERT INTO recording (
    folder_name, recording_id_hex, datetime, duration_ms,
    mode_name, model_key, model_name, language_model_key, language_model_name,
    recording_device, language, app_name, app_category,
    raw_word_count, llm_word_count, result, llm_result, raw_result,
    has_audio, meta_path, audio_path, indexed_at
  ) VALUES (
    $folder_name, $recording_id_hex, $datetime, $duration_ms,
    $mode_name, $model_key, $model_name, $language_model_key, $language_model_name,
    $recording_device, $language, $app_name, $app_category,
    $raw_word_count, $llm_word_count, $result, $llm_result, $raw_result,
    $has_audio, $meta_path, $audio_path, $indexed_at
  )
  ON CONFLICT(folder_name) DO UPDATE SET
    datetime = excluded.datetime,
    duration_ms = excluded.duration_ms,
    mode_name = excluded.mode_name,
    model_key = excluded.model_key,
    model_name = excluded.model_name,
    language_model_key = excluded.language_model_key,
    language_model_name = excluded.language_model_name,
    recording_device = excluded.recording_device,
    language = COALESCE(excluded.language, recording.language),
    app_name = COALESCE(excluded.app_name, recording.app_name),
    app_category = COALESCE(excluded.app_category, recording.app_category),
    raw_word_count = excluded.raw_word_count,
    llm_word_count = excluded.llm_word_count,
    result = excluded.result,
    llm_result = excluded.llm_result,
    raw_result = excluded.raw_result,
    has_audio = excluded.has_audio,
    meta_path = excluded.meta_path,
    audio_path = excluded.audio_path,
    indexed_at = excluded.indexed_at
`;

/**
 * Outcome of `applyRecordingUpsert`: whether the row pre-existed
 * (i.e. was UPDATED rather than INSERTed).
 */
export interface UpsertOutcome {
  existed: boolean;
}

/**
 * Apply RECORDING_UPSERT_SQL for a single (row, meta) pair. Caller
 * provides prepared statements so the bulk path can reuse them across
 * many rows; the per-folder path prepares them inline.
 *
 * Caller is responsible for wrapping in a transaction.
 */
export function applyRecordingUpsert(
  upsertStmt: ReturnType<Database["prepare"]>,
  existsStmt: ReturnType<Database["prepare"]>,
  row: SourceRecording,
  meta: MetaContext,
  nowIso: string,
): UpsertOutcome {
  const existedRaw: unknown = existsStmt.get(row.folderName);
  const existed = existedRaw != null && ExistsRowSchema.safeParse(existedRaw).success;
  upsertStmt.run({
    $folder_name: row.folderName,
    $recording_id_hex: row.recordingIdHex,
    $datetime: row.datetime,
    $duration_ms: row.durationMs,
    $mode_name: row.modeName,
    $model_key: row.modelKey,
    $model_name: row.modelName,
    $language_model_key: row.languageModelKey,
    $language_model_name: row.languageModelName,
    $recording_device: row.recordingDevice,
    $language: meta.language,
    $app_name: meta.appName,
    $app_category: meta.appCategory,
    $raw_word_count: row.rawWordCount,
    $llm_word_count: row.llmWordCount,
    $result: row.result,
    $llm_result: row.llmResult,
    $raw_result: row.rawResult,
    $has_audio: meta.hasAudio ? 1 : 0,
    $meta_path: meta.metaPath,
    $audio_path: meta.audioPath,
    $indexed_at: nowIso,
  });
  return { existed };
}

/**
 * Top-level entry that the CLI calls before every `swrag sql` and on every
 * launchd tick.
 *
 * 1. Fast path: if the source DB mtime is unchanged AND the embed model
 *    hasn't switched, return immediately.
 * 2. Otherwise: snapshot, read incremental rows, enrich with meta.json,
 *    upsert, mark deletions, audio liveness, and (unless skipEmbeddings)
 *    refresh `recording_vec`.
 */
export async function ensureFresh(opts: IngestOptions): Promise<IngestResult> {
  const t0 = Date.now();
  const sourceMtime = sourceDbMtimeNs(opts.sourceDb);
  if (sourceMtime == null) {
    throw new Error(`source DB not found: ${opts.sourceDb}`);
  }

  // Open archive (creates if missing) just to check the fast-path config.
  return withArchive(opts.archive, {}, async (archive) => {
    try {
      // Apply pending data updaters before the fast-path check. An
      // updater that ran here means the binary has new computed-state
      // expectations the archive hasn't satisfied yet — we must take
      // the slow path so `embedDirtyRows` (and friends) get a chance to
      // reconcile, even if the source DB mtime is unchanged.
      const updaterOutcome = await runUpdaters(archive, opts);
      const updatersRan = updaterOutcome.applied.length > 0;
      if (updatersRan) {
        info(
          `update: ${updaterOutcome.fromVersion} -> ${updaterOutcome.toVersion}` +
            ` (applied ${updaterOutcome.applied.join(", ")})`,
        );
      }

      const storedMtime = getConfig(archive, "source_mtime_ns");
      const storedModel = getConfig(archive, "embed_model");
      const sourceMtimeStr = sourceMtime.toString();
      const modelSwitched = !!storedModel && storedModel !== opts.embedModel;

      if (!updatersRan && storedMtime === sourceMtimeStr && !modelSwitched) {
        return {
          fastPath: true,
          newRows: 0,
          updatedRows: 0,
          embedded: 0,
          sourceDeletions: 0,
          audioChanges: 0,
          modelSwitched: false,
          durationMs: Date.now() - t0,
        };
      }

      setConfig(archive, "last_sync_started_at", new Date().toISOString());
      setConfig(archive, "super_whisper_db_path", opts.sourceDb);
      setConfig(archive, "super_whisper_recordings_dir", recordingsDir(opts.sourceDir));

      if (modelSwitched) {
        info(`embed model changed (${storedModel} -> ${opts.embedModel}); re-embedding all rows`);
        archive.exec("DELETE FROM recording_vec");
        // Also wipe chunk vectors — they'll be re-embedded under the
        // new model on the next embed pass. Chunk text rows + their
        // FTS index stay (text is invariant under model change), which
        // the long-path takes advantage of via the "reuse mode" branch
        // in `embedLongRow`.
        archive.exec("DELETE FROM recording_chunk_vec");
        archive.exec(
          "UPDATE recording SET embed_text_hash = NULL, embed_model = NULL, embed_dim = NULL",
        );
      }

      const snap = snapshotSourceDb(opts.sourceDb);
      try {
        const since = getConfig(archive, "last_indexed_datetime") ?? null;
        const newRows = readSourceRecordings(snap.path, since);
        const sourceFolders = readSourceFolderNames(snap.path);
        verbose(
          `source has ${sourceFolders.size} rows total; ${newRows.length} new since ${since ?? "epoch"}`,
        );

        const rdir = recordingsDir(opts.sourceDir);
        const upserts = await Promise.all(
          newRows.map((row) =>
            readMetaContext(rdir, row.folderName).then((meta) => ({
              row,
              meta,
            })),
          ),
        );

        const nowIso = new Date().toISOString();
        const upsertStmt = archive.prepare(RECORDING_UPSERT_SQL);
        const existsStmt = archive.prepare(
          "SELECT folder_name FROM recording WHERE folder_name = ?",
        );

        let upserted = 0;
        let updated = 0;
        let latestDt = since ?? "";

        const tx = archive.transaction(() => {
          for (const { row, meta } of upserts) {
            const outcome = applyRecordingUpsert(upsertStmt, existsStmt, row, meta, nowIso);
            if (outcome.existed) updated++;
            else upserted++;
            if (row.datetime > latestDt) latestDt = row.datetime;
          }
        });
        tx();

        const deletions = markSourceDeletions(archive, sourceFolders, nowIso);
        const audioChanges = refreshAudioLiveness(archive, nowIso);

        // After upserts: hash any new audio files and propagate supersedence.
        // Same-audio reprocessings produce multiple rows in Super Whisper; we
        // keep them all (the archive is append-only) but mark all but the
        // newest as superseded so default queries can ignore the older ones.
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
        verbose(`supersedence pass marked ${superseded} rows as superseded`);

        if (latestDt) setConfig(archive, "last_indexed_datetime", latestDt);
        setConfig(archive, "source_mtime_ns", sourceMtimeStr);
        setConfig(archive, "embed_model", opts.embedModel);
        setConfig(archive, "last_sync_finished_at", new Date().toISOString());
        setConfig(archive, "last_sync_error", "");

        return {
          fastPath: false,
          newRows: upserted,
          updatedRows: updated,
          embedded,
          sourceDeletions: deletions,
          audioChanges,
          modelSwitched,
          durationMs: Date.now() - t0,
        };
      } finally {
        snap.dispose();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConfig(archive, "last_sync_error", msg);
      throw e;
    }
  });
}

function recordingsDir(sourceDir: string): string {
  return join(sourceDir, "recordings");
}

export interface EmbedDirtyOpts {
  model: string;
  host: string;
  fn?: (texts: string[]) => Promise<Float32Array[]>;
}

interface ShortDirty {
  folder_name: string;
  text: string;
  hash: string;
}

interface LongDirty {
  folder_name: string;
  body: string;
  mode_name: string;
  hash: string;
}

/**
 * Detect "dirty" canonical rows and embed them.
 *
 * Three orthogonal dirty-detection rules, any of which marks a row:
 *
 *   1. `embed_text_hash` or `embed_model` mismatch (existing behavior —
 *      catches text changes and post-model-switch re-embed).
 *   2. Missing `recording_vec` entry (defence-in-depth against any code
 *      path that nukes a vec row without also clearing the hash).
 *   3. **Long row missing chunks** — catches the first-run backfill
 *      case where existing long rows have a valid whole-doc hash but
 *      no `recording_chunk` rows yet.
 *
 * A row is routed to one of two paths based on whether it exceeds the
 * configured word-count threshold:
 *
 *   - **Short** (today's behavior): one `embedBatch` call per row,
 *     single vector upserted to `recording_vec`. Also wipes any chunks
 *     belonging to the row, in case a previously-long row dropped below
 *     the threshold.
 *   - **Long**: chunk the source body → embed each chunk → store chunks
 *     + chunk_vec + L2-normalized centroid in `recording_vec` (all in
 *     one transaction per row, see `embedLongRow`).
 *
 * A `chunk_strategy` config-key mismatch (orthogonal config-change rule)
 * triggers an up-front bulk wipe of `recording_chunk*` so that rule (3)
 * fires for every long row on this pass.
 *
 * Note: we intentionally do NOT LEFT JOIN against `recording_vec` /
 * `recording_chunk_vec` to detect missing entries. The vec0 virtual
 * table doesn't behave like a regular table in LEFT JOIN (returns no
 * row instead of NULL-padding for non-matches in some sqlite-vec
 * versions). Fetch existing folder_names separately and check
 * membership in JS — slower in theory, correct in practice.
 */
export async function embedDirtyRows(archive: Database, opts: EmbedDirtyOpts): Promise<number> {
  const strategy = DEFAULT_CHUNK_STRATEGY;
  const currentStrategyJson = serializeChunkStrategy(strategy);
  const storedStrategy = getConfig(archive, "chunk_strategy");
  const strategyChanged = !!storedStrategy && storedStrategy !== currentStrategyJson;
  if (strategyChanged) {
    info(
      `chunk_strategy changed (${storedStrategy} -> ${currentStrategyJson}); rechunking long rows`,
    );
    // Up-front wipe. The AFTER DELETE trigger on `recording_chunk`
    // cleans up the FTS index. `recording_chunk_vec` has no FK and must
    // be wiped explicitly first.
    archive.exec("DELETE FROM recording_chunk_vec");
    archive.exec("DELETE FROM recording_chunk");
  }

  const raw: unknown[] = archive
    .prepare(
      `SELECT folder_name, mode_name, llm_result, raw_result,
              llm_word_count, raw_word_count, embed_text_hash, embed_model
       FROM recording
       WHERE superseded_by IS NULL`,
    )
    .all();
  const candidates: DirtyRow[] = raw.map((r) => DirtyRowSchema.parse(r));

  const vecRaw: unknown[] = archive.prepare("SELECT folder_name FROM recording_vec").all();
  const haveVec = new Set(vecRaw.map((r) => VecFolderRowSchema.parse(r).folder_name));

  const chunkRaw: unknown[] = archive
    .prepare("SELECT DISTINCT folder_name FROM recording_chunk")
    .all();
  const haveChunks = new Set(chunkRaw.map((r) => ChunkFolderRowSchema.parse(r).folder_name));

  const shortDirty: ShortDirty[] = [];
  const longDirty: LongDirty[] = [];

  for (const r of candidates) {
    const body = chunkSourceBody(r);
    if (!body) continue;
    const text = `[${r.mode_name}] ${body}`;
    const hash = sha256(text);
    const isLong = wordCountForChunking(r) > strategy.threshold;
    const hashMatches = r.embed_text_hash === hash && r.embed_model === opts.model;
    const hasVec = haveVec.has(r.folder_name);
    const hasChunksIfLong = !isLong || haveChunks.has(r.folder_name);
    if (hashMatches && hasVec && hasChunksIfLong) continue;

    if (isLong) {
      longDirty.push({ folder_name: r.folder_name, body, mode_name: r.mode_name, hash });
    } else {
      shortDirty.push({ folder_name: r.folder_name, text, hash });
    }
  }

  if (shortDirty.length === 0 && longDirty.length === 0) {
    // No work to do, but still persist the strategy so future runs can
    // detect changes against this baseline.
    setConfig(archive, "chunk_strategy", currentStrategyJson);
    return 0;
  }

  info(
    `embedding ${shortDirty.length + longDirty.length} rows with ${opts.model}` +
      ` (${shortDirty.length} short, ${longDirty.length} long)`,
  );

  let embedded = 0;
  if (shortDirty.length > 0) {
    embedded += await embedShortRows(archive, opts, shortDirty);
  }
  for (const row of longDirty) {
    await embedLongRow(archive, opts, row);
    embedded++;
  }

  setConfig(archive, "chunk_strategy", currentStrategyJson);
  return embedded;
}

/**
 * Short-row path. Mirrors the original `embedDirtyRows` behavior with
 * one addition: also wipe any chunk rows for this folder, in case a
 * previously-long recording dropped below the threshold and now lives
 * on the single-vector path.
 *
 * We deliberately do not use `INSERT OR REPLACE` on `recording_vec` —
 * the vec0 virtual table's xUpdate doesn't go through SQLite's
 * standard conflict-resolution path, so colliding inserts surface as
 * "UNIQUE constraint failed" instead of being silently replaced.
 * Always DELETE then INSERT.
 */
async function embedShortRows(
  archive: Database,
  opts: EmbedDirtyOpts,
  rows: ShortDirty[],
): Promise<number> {
  const deleteVec = archive.prepare("DELETE FROM recording_vec WHERE folder_name = ?");
  const insertVec = archive.prepare(
    "INSERT INTO recording_vec (folder_name, embedding) VALUES (?, ?)",
  );
  // Cleanup for the long-to-short transition. No-op for rows that were
  // always short (no chunks ever existed for them).
  const deleteChunkVec = archive.prepare(
    "DELETE FROM recording_chunk_vec WHERE chunk_id IN (SELECT id FROM recording_chunk WHERE folder_name = ?)",
  );
  const deleteChunks = archive.prepare("DELETE FROM recording_chunk WHERE folder_name = ?");
  const updateRow = archive.prepare(
    "UPDATE recording SET embed_model = ?, embed_dim = ?, embed_text_hash = ? WHERE folder_name = ?",
  );

  let embedded = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedTexts(
      batch.map((b) => b.text),
      opts,
    );
    const tx = archive.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const v = vectors[j];
        if (!item || !v) continue;
        deleteVec.run(item.folder_name);
        insertVec.run(item.folder_name, v);
        deleteChunkVec.run(item.folder_name);
        deleteChunks.run(item.folder_name);
        updateRow.run(opts.model, v.length, item.hash, item.folder_name);
      }
    });
    tx();
    embedded += batch.length;
    verbose(`embedded ${embedded}/${rows.length} short`);
  }
  return embedded;
}

/**
 * Long-row path. Chunks `row.body` (or reuses existing chunks if they
 * survived a model-only change), embeds each chunk, then atomically
 * writes chunks + chunk_vec + L2-normalized centroid in one transaction.
 *
 * Two modes:
 *
 *   - **reuse**: chunk text rows already exist (typical after an
 *     `embed_model` switch — text is invariant under model change, so
 *     we keep the rows and just re-embed). Cheaper than a rebuild.
 *   - **create**: no chunk rows exist (typical on first backfill or
 *     after a `chunk_strategy` change). Generate chunks via the chunker
 *     and insert them.
 *
 * Embedding happens outside the transaction (network I/O — we must not
 * hold a write lock during it). DB writes are all inside one short
 * transaction so an interrupted run leaves the DB consistent.
 */
async function embedLongRow(
  archive: Database,
  opts: EmbedDirtyOpts,
  row: LongDirty,
): Promise<void> {
  const existing = readExistingChunks(archive, row.folder_name);
  let chunkIds: number[] | null = existing.length > 0 ? existing.map((c) => c.id) : null;
  const chunkSpecs: Chunk[] =
    existing.length > 0
      ? existing.map((c) => ({
          chunk_idx: c.chunk_idx,
          text: c.text,
          start_word: c.start_word,
          end_word: c.end_word,
          word_count: c.word_count,
        }))
      : chunkText(row.body);
  if (chunkSpecs.length === 0) {
    throw new Error(`chunker produced 0 chunks for long row ${row.folder_name}`);
  }

  const embedTextsForChunks = chunkSpecs.map((c) => `[${row.mode_name}] ${c.text}`);
  const vectors = await embedTexts(embedTextsForChunks, opts);
  if (vectors.length !== chunkSpecs.length) {
    throw new Error(
      `embed returned ${vectors.length} vectors for ${chunkSpecs.length} chunks of ${row.folder_name}`,
    );
  }
  const centroid = l2NormalizedCentroid(vectors);

  const deleteOldChunkVec = archive.prepare(
    "DELETE FROM recording_chunk_vec WHERE chunk_id IN (SELECT id FROM recording_chunk WHERE folder_name = ?)",
  );
  const deleteOldChunks = archive.prepare("DELETE FROM recording_chunk WHERE folder_name = ?");
  const insertChunk = archive.prepare(
    "INSERT INTO recording_chunk (folder_name, chunk_idx, text, start_word, end_word, word_count) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertChunkVec = archive.prepare(
    "INSERT INTO recording_chunk_vec (chunk_id, embedding) VALUES (?, ?)",
  );
  const deleteVec = archive.prepare("DELETE FROM recording_vec WHERE folder_name = ?");
  const insertVec = archive.prepare(
    "INSERT INTO recording_vec (folder_name, embedding) VALUES (?, ?)",
  );
  const updateRow = archive.prepare(
    "UPDATE recording SET embed_model = ?, embed_dim = ?, embed_text_hash = ? WHERE folder_name = ?",
  );

  const tx = archive.transaction(() => {
    if (chunkIds !== null) {
      // Reuse mode: wipe vec entries, then re-insert under existing ids.
      deleteOldChunkVec.run(row.folder_name);
      for (let i = 0; i < chunkIds.length; i++) {
        const id = chunkIds[i];
        const v = vectors[i];
        if (id == null || !v) continue;
        insertChunkVec.run(id, v);
      }
    } else {
      // Create mode: wipe vec (defence-in-depth — usually no-op since
      // existing.length === 0 means no chunks → no vec entries either),
      // wipe chunk text rows (no-op too), then insert fresh.
      deleteOldChunkVec.run(row.folder_name);
      deleteOldChunks.run(row.folder_name);
      const freshIds: number[] = [];
      for (const c of chunkSpecs) {
        const result = insertChunk.run(
          row.folder_name,
          c.chunk_idx,
          c.text,
          c.start_word,
          c.end_word,
          c.word_count,
        );
        freshIds.push(Number(result.lastInsertRowid));
      }
      for (let i = 0; i < freshIds.length; i++) {
        const id = freshIds[i];
        const v = vectors[i];
        if (id == null || !v) continue;
        insertChunkVec.run(id, v);
      }
    }
    deleteVec.run(row.folder_name);
    insertVec.run(row.folder_name, centroid);
    updateRow.run(opts.model, centroid.length, row.hash, row.folder_name);
  });
  tx();
  verbose(`embedded long row ${row.folder_name}: ${chunkSpecs.length} chunks`);
}

function readExistingChunks(archive: Database, folder: string): ExistingChunkRow[] {
  const raw: unknown[] = archive
    .prepare(
      "SELECT id, chunk_idx, text, start_word, end_word, word_count FROM recording_chunk WHERE folder_name = ? ORDER BY chunk_idx",
    )
    .all(folder);
  return raw.map((r) => ExistingChunkRowSchema.parse(r));
}

/**
 * Batch-embed an array of strings via Ollama (or the test stub), preserving
 * order. Splits into batches of `EMBED_BATCH_SIZE` under the hood.
 */
async function embedTexts(texts: string[], opts: EmbedDirtyOpts): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = opts.fn
      ? await opts.fn(batch)
      : await embedBatch(batch, { model: opts.model, host: opts.host });
    if (vectors.length !== batch.length) {
      throw new Error(`embed returned ${vectors.length} vectors for batch of ${batch.length}`);
    }
    for (const v of vectors) out.push(v);
  }
  return out;
}

/**
 * Compute the L2-normalized centroid of a non-empty list of vectors.
 *
 * Every row in `recording_vec` written by `embedDirtyRows` is L2-normalized
 * — bge-m3 returns unit vectors and Ollama passes them through untouched
 * (verified empirically: `SELECT SQRT(SUM(value*value)) FROM
 * json_each(vec_to_json(embedding))` returns 1.0 within float32 epsilon
 * for every row written by today's short path). The arithmetic-mean
 * centroid is sub-unit by construction (mean of unit vectors at non-zero
 * angles to each other), so we renormalize to preserve the invariant.
 *
 * Ranking via `vec_distance_cosine` is identical with or without
 * normalization, but keeping the invariant lets future code switch to
 * cheaper inner-product distance without auditing every writer.
 *
 * Cost is one `Math.hypot`-equivalent (sum of squares, sqrt) plus 1024
 * divides per long row — well under a microsecond, lost in the noise of
 * the preceding network embed call.
 */
function l2NormalizedCentroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error("centroid of empty vector list");
  const head = vectors[0];
  if (!head) throw new Error("centroid: first vector is missing");
  const dim = head.length;
  const sum = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`centroid: mixed dimensions (${v.length} vs ${dim})`);
    }
    for (let i = 0; i < dim; i++) {
      sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
    }
  }
  let normSq = 0;
  for (let i = 0; i < dim; i++) {
    const x = sum[i] ?? 0;
    normSq += x * x;
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    // Pathological: vectors averaged to zero. Should never happen for
    // bge-m3 output (which is L2-normalized non-zero), but if it does
    // fall back to the first input rather than divide by zero.
    return head;
  }
  for (let i = 0; i < dim; i++) {
    sum[i] = (sum[i] ?? 0) / norm;
  }
  return sum;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Compute a stable SHA-1 of the audio file for any row whose audio_path
 * exists on disk but whose audio_hash is still NULL in the archive. We
 * only hash files we haven't seen before; existing hashes are stable
 * because Super Whisper never rewrites an audio file in place.
 *
 * Hashing happens outside the transaction (it's streamed I/O — we
 * shouldn't hold a write lock for it). We collect (folder_name, hash)
 * tuples first, then apply them in a single short transaction.
 */
export async function hashNewAudioFiles(archive: Database): Promise<void> {
  const raw: unknown[] = archive
    .prepare(
      `SELECT folder_name, audio_path
       FROM recording
       WHERE audio_hash IS NULL AND audio_path IS NOT NULL`,
    )
    .all();
  const candidates = raw.map((r) => AudioHashRowSchema.parse(r));
  if (candidates.length === 0) return;
  const computed: { folder_name: string; hash: string }[] = [];
  for (const row of candidates) {
    if (!row.audio_path || !existsSync(row.audio_path)) continue;
    try {
      const hash = await sha1File(row.audio_path);
      computed.push({ folder_name: row.folder_name, hash });
    } catch (e) {
      verbose(
        `audio hash failed for ${row.folder_name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (computed.length === 0) return;
  const update = archive.prepare("UPDATE recording SET audio_hash = ? WHERE folder_name = ?");
  const tx = archive.transaction(() => {
    for (const c of computed) update.run(c.hash, c.folder_name);
  });
  tx();
  verbose(`hashed ${computed.length} new audio files`);
}

/**
 * Detect Super Whisper reprocessings (multiple rows sharing the same
 * audio_hash) and mark all but the newest as superseded. Idempotent: a
 * subsequent call with no new hashes is a no-op.
 *
 * Strategy: group canonical-eligible rows by audio_hash, pick the one
 * with the latest `datetime` (which equals the reprocess timestamp), and
 * set `superseded_by = <canonical folder>` + `superseded_at = nowIso` on
 * the rest.
 */
export function refreshSupersedence(archive: Database, nowIso: string): number {
  const raw: unknown[] = archive
    .prepare(
      `SELECT folder_name, audio_hash, datetime
       FROM recording
       WHERE audio_hash IS NOT NULL`,
    )
    .all();
  const rows = raw.map((r) => SupersedenceRowSchema.parse(r));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const bucket = groups.get(r.audio_hash) ?? [];
    bucket.push(r);
    groups.set(r.audio_hash, bucket);
  }
  const setSuperseded = archive.prepare(
    "UPDATE recording SET superseded_by = ?, superseded_at = ? WHERE folder_name = ?",
  );
  const clearSuperseded = archive.prepare(
    "UPDATE recording SET superseded_by = NULL, superseded_at = NULL WHERE folder_name = ?",
  );
  // Drop the vector for any row we mark as superseded. Without this,
  // `recording_vec` would slowly accumulate orphans: queries already
  // filter `superseded_by IS NULL` via the canonical join, so the bug
  // is silent but it wastes space and risks confusing future readers
  // who assume vec rows are canonical.
  const deleteVec = archive.prepare("DELETE FROM recording_vec WHERE folder_name = ?");
  // Same reasoning for chunk-level tables: drop chunks (FTS is cleaned
  // by the AFTER DELETE trigger) and chunk_vec rows for superseded
  // folders. vec0 has no FKs so chunk_vec must go first.
  const deleteChunkVec = archive.prepare(
    "DELETE FROM recording_chunk_vec WHERE chunk_id IN (SELECT id FROM recording_chunk WHERE folder_name = ?)",
  );
  const deleteChunks = archive.prepare("DELETE FROM recording_chunk WHERE folder_name = ?");
  // Alongside the vec drop: clear embed_text_hash/model so that if this
  // row ever gets promoted back to canonical (e.g. the duplicate's
  // audio_hash changes), `embedDirtyRows` re-embeds it. Without this
  // the row would land in the canonical set with no vec entry at all,
  // silently absent from semantic search.
  const clearEmbed = archive.prepare(
    "UPDATE recording SET embed_text_hash = NULL, embed_model = NULL, embed_dim = NULL WHERE folder_name = ?",
  );
  let changed = 0;
  const tx = archive.transaction(() => {
    for (const [, bucket] of groups) {
      if (bucket.length <= 1) {
        // Single-row group → ensure it's canonical (clear any stale mark).
        const only = bucket[0];
        if (only) clearSuperseded.run(only.folder_name);
        continue;
      }
      const sorted = [...bucket].sort((a, b) =>
        a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0,
      );
      const canonical = sorted[0];
      if (!canonical) continue;
      clearSuperseded.run(canonical.folder_name);
      for (let i = 1; i < sorted.length; i++) {
        const r = sorted[i];
        if (!r) continue;
        setSuperseded.run(canonical.folder_name, nowIso, r.folder_name);
        deleteVec.run(r.folder_name);
        deleteChunkVec.run(r.folder_name);
        deleteChunks.run(r.folder_name);
        clearEmbed.run(r.folder_name);
        changed++;
      }
    }
  });
  tx();
  return changed;
}

/**
 * Stream the file through SHA-1 so we don't allocate the whole audio
 * payload up front. Long-form dictations can be 100+ MB; the previous
 * `readFileSync` would keep that entire buffer resident until the hash
 * finished.
 */
async function sha1File(path: string): Promise<string> {
  const h = createHash("sha1");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) h.update(chunk);
  return h.digest("hex");
}
