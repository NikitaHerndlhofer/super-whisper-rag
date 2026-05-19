import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { EMBED_BATCH_SIZE } from "../config.ts";
import { embedBatch } from "../embed/ollama.ts";
import { info, verbose } from "../log.ts";
import { getConfig, setConfig, withArchive } from "../archive/open.ts";
import {
  readMetaContext,
  readSourceFolderNames,
  readSourceRecordings,
  sourceDbMtimeNs,
} from "./sources.ts";
import { snapshotSourceDb } from "./snapshot.ts";
import { markSourceDeletions, refreshAudioLiveness } from "./deletions.ts";

const DirtyRowSchema = z.object({
  folder_name: z.string(),
  mode_name: z.string(),
  llm_result: z.string().nullable(),
  raw_result: z.string().nullable(),
  embed_text_hash: z.string().nullable(),
  embed_model: z.string().nullable(),
});
type DirtyRow = z.infer<typeof DirtyRowSchema>;

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
  /** When true, force a full re-embed even if the model hasn't changed. */
  full?: boolean;
  /** When true, do everything except writes / embeddings; print the plan. */
  dryRun?: boolean;
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
      const storedMtime = getConfig(archive, "source_mtime_ns");
      const storedModel = getConfig(archive, "embed_model");
      const sourceMtimeStr = sourceMtime.toString();
      const modelSwitched = !!storedModel && storedModel !== opts.embedModel;

      if (!opts.full && storedMtime === sourceMtimeStr && !modelSwitched && !opts.dryRun) {
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

      if (modelSwitched || opts.full) {
        info(
          modelSwitched
            ? `embed model changed (${storedModel} -> ${opts.embedModel}); re-embedding all rows`
            : `--full: re-embedding all rows`,
        );
        archive.exec("DELETE FROM recording_vec");
        archive.exec(
          "UPDATE recording SET embed_text_hash = NULL, embed_model = NULL, embed_dim = NULL",
        );
      }

      const snap = snapshotSourceDb(opts.sourceDb);
      try {
        const since = opts.full ? null : (getConfig(archive, "last_indexed_datetime") ?? null);
        const newRows = readSourceRecordings(snap.path, since);
        const sourceFolders = readSourceFolderNames(snap.path);
        verbose(
          `source has ${sourceFolders.size} rows total; ${newRows.length} new since ${since ?? "epoch"}`,
        );

        const rdir = recordingsDir(opts.sourceDir);
        const upserts = await Promise.all(
          newRows.map((row) =>
            readMetaContext(rdir, row.folderName).then((meta) => ({ row, meta })),
          ),
        );

        const nowIso = new Date().toISOString();
        const upsertStmt = archive.prepare(`
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
      `);

        let upserted = 0;
        let updated = 0;
        let latestDt = since ?? "";
        const existsStmt = archive.prepare(
          "SELECT folder_name FROM recording WHERE folder_name = ?",
        );

        const tx = archive.transaction(() => {
          for (const { row, meta } of upserts) {
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
            if (existed) updated++;
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
        hashNewAudioFiles(archive);
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

interface EmbedDirtyOpts {
  model: string;
  host: string;
  fn?: (texts: string[]) => Promise<Float32Array[]>;
}

async function embedDirtyRows(archive: Database, opts: EmbedDirtyOpts): Promise<number> {
  // Only embed canonical rows. Superseded rows are duplicates of a later
  // reprocess of the same audio; embedding them wastes Ollama calls.
  const raw: unknown[] = archive
    .prepare(
      `SELECT folder_name, mode_name, llm_result, raw_result, embed_text_hash, embed_model
       FROM recording
       WHERE superseded_by IS NULL`,
    )
    .all();
  const candidates: DirtyRow[] = raw.map((r) => DirtyRowSchema.parse(r));

  const dirty: { folder_name: string; text: string; hash: string }[] = [];
  for (const r of candidates) {
    const text = embedText(r);
    if (!text) continue;
    const hash = sha256(text);
    if (r.embed_text_hash === hash && r.embed_model === opts.model) continue;
    dirty.push({ folder_name: r.folder_name, text, hash });
  }

  if (dirty.length === 0) return 0;
  info(`embedding ${dirty.length} rows with ${opts.model}`);

  const upsertVec = archive.prepare(
    "INSERT OR REPLACE INTO recording_vec (folder_name, embedding) VALUES (?, ?)",
  );
  const updateRow = archive.prepare(
    "UPDATE recording SET embed_model = ?, embed_dim = ?, embed_text_hash = ? WHERE folder_name = ?",
  );

  let embedded = 0;
  for (let i = 0; i < dirty.length; i += EMBED_BATCH_SIZE) {
    const batch = dirty.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((b) => b.text);
    const vectors = opts.fn
      ? await opts.fn(texts)
      : await embedBatch(texts, { model: opts.model, host: opts.host });
    if (vectors.length !== batch.length) {
      throw new Error(`embed returned ${vectors.length} vectors for batch of ${batch.length}`);
    }
    const tx = archive.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const v = vectors[j];
        if (!item || !v) continue;
        upsertVec.run(item.folder_name, v);
        updateRow.run(opts.model, v.length, item.hash, item.folder_name);
      }
    });
    tx();
    embedded += batch.length;
    verbose(`embedded ${embedded}/${dirty.length}`);
  }
  return embedded;
}

/**
 * Prefer the LLM-processed transcript; fall back to the raw transcription
 * only when no LLM output exists. We deliberately do not consult Super
 * Whisper's `result` column — observation shows it's a lightly-trimmed copy
 * of `rawResult`, not a fresh signal.
 */
function embedText(r: DirtyRow): string {
  const body = r.llm_result || r.raw_result || "";
  if (!body.trim()) return "";
  return `[${r.mode_name}] ${body}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Compute a stable SHA-1 of the audio file for any row whose audio_path
 * exists on disk but whose audio_hash is still NULL in the archive. We
 * only hash files we haven't seen before; existing hashes are stable
 * because Super Whisper never rewrites an audio file in place.
 */
function hashNewAudioFiles(archive: Database): void {
  const raw: unknown[] = archive
    .prepare(
      `SELECT folder_name, audio_path
       FROM recording
       WHERE audio_hash IS NULL AND audio_path IS NOT NULL`,
    )
    .all();
  const candidates = raw.map((r) => AudioHashRowSchema.parse(r));
  if (candidates.length === 0) return;
  const update = archive.prepare("UPDATE recording SET audio_hash = ? WHERE folder_name = ?");
  const tx = archive.transaction(() => {
    let hashed = 0;
    for (const row of candidates) {
      if (!row.audio_path || !existsSync(row.audio_path)) continue;
      try {
        const hash = sha1File(row.audio_path);
        update.run(hash, row.folder_name);
        hashed++;
      } catch (e) {
        verbose(
          `audio hash failed for ${row.folder_name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (hashed > 0) verbose(`hashed ${hashed} new audio files`);
  });
  tx();
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
function refreshSupersedence(archive: Database, nowIso: string): number {
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
        changed++;
      }
    }
  });
  tx();
  return changed;
}

function sha1File(path: string): string {
  const data = readFileSync(path);
  return createHash("sha1").update(data).digest("hex");
}
