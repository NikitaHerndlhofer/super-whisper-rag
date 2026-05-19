import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { verbose, warn } from "../log.ts";
import { MetaJsonSchema, SourceRecordingSchema, type SourceRecording } from "../schemas.ts";

export type { SourceRecording };

const FolderNameRowSchema = z.object({ folderName: z.string() });

/**
 * Real Super Whisper schema (verified against v3.x DB on disk).
 *
 *   recording(
 *     id TEXT PK,                 -- uuid-style; NOT a blob, despite older notes
 *     datetime DATETIME,          -- recording (or reprocess) timestamp
 *     duration DOUBLE,            -- ms; PRESERVED across reprocessings
 *     appVersion TEXT,
 *     modelKey TEXT,
 *     modelName TEXT,
 *     languageModelName TEXT,
 *     recordingDevice TEXT,
 *     rawWordCount INTEGER,
 *     llmWordCount INTEGER,
 *     prompt TEXT,                -- the LLM system prompt; large
 *     processingTime INTEGER,
 *     languageModelProcessingTime INTEGER,
 *     modeName TEXT,
 *     promptContext TEXT,         -- JSON; overlaps with meta.json
 *     folderName TEXT,
 *     fromFile BOOLEAN,
 *     createdAt DATETIME,         -- row insertion time
 *     languageModelKey TEXT
 *   )
 *   recording_fts(recordingId, llmResult, rawResult, result)
 *
 * The transcripts live in the FTS virtual table — we LEFT JOIN to bring
 * them onto the row. `hex(r.id)` produces a stable string regardless of
 * whether `id` is stored as TEXT or BLOB (SQLite duck-typing), so the
 * rest of the pipeline can treat the row's PK as a hex string.
 *
 * Columns we deliberately don't read: `appVersion`, `prompt`,
 * `promptContext`, `processingTime`, `languageModelProcessingTime`,
 * `fromFile`, `createdAt`. None of them surfaces in the cookbook today
 * and `prompt` in particular is large. Add them only when a concrete
 * query needs them — same rule as everywhere else in this project.
 *
 * Note on reprocessings: Super Whisper does NOT provide any
 * back-reference (no parentId, no audioHash, no recordingGroupId)
 * linking a reprocess to its original. `datetime`, `folderName`, and
 * `id` are all reset; `duration` is the only field that survives. We
 * recover the linkage by SHA-1 hashing `output.wav` ourselves — see
 * `hashNewAudioFiles` in `ingester.ts` and migration 002.
 */
const SELECT_ROWS = `
SELECT
  r.folderName,
  hex(r.id)     AS recordingIdHex,
  r.datetime,
  r.duration    AS durationMs,
  r.modeName,
  r.modelKey,
  r.modelName,
  r.languageModelKey,
  r.languageModelName,
  r.recordingDevice,
  r.rawWordCount,
  r.llmWordCount,
  fts.result,
  fts.llmResult,
  fts.rawResult
FROM recording r
LEFT JOIN recording_fts fts ON fts.recordingId = r.id
`;

/**
 * Open a Super Whisper SQLite file read-only and return rows newer than
 * `sinceDatetime` (ISO8601). Pass `null` to read everything.
 */
export function readSourceRecordings(
  path: string,
  sinceDatetime: string | null,
): SourceRecording[] {
  if (!existsSync(path)) {
    throw new Error(`source DB not found: ${path}`);
  }
  const db = new Database(path, { readonly: true });
  try {
    const sql =
      sinceDatetime != null
        ? `${SELECT_ROWS} WHERE r.datetime > ? ORDER BY r.datetime ASC`
        : `${SELECT_ROWS} ORDER BY r.datetime ASC`;
    const stmt = db.prepare(sql);
    const raw: unknown[] = sinceDatetime != null ? stmt.all(sinceDatetime) : stmt.all();
    return raw.map((r) => SourceRecordingSchema.parse(r));
  } finally {
    db.close();
  }
}

/** All folder names currently present in the source DB. */
export function readSourceFolderNames(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const db = new Database(path, { readonly: true });
  try {
    const rows: unknown[] = db.prepare("SELECT folderName FROM recording").all();
    const out = new Set<string>();
    for (const r of rows) {
      const parsed = FolderNameRowSchema.safeParse(r);
      if (parsed.success) out.add(parsed.data.folderName);
    }
    return out;
  } finally {
    db.close();
  }
}

export interface MetaContext {
  metaPath: string;
  audioPath: string | null;
  hasAudio: boolean;
  language: string | null;
  appName: string | null;
  appCategory: string | null;
  /** The raw, validated meta.json payload, used by `swrag show --include all`. */
  raw: Record<string, unknown> | null;
}

/**
 * Look up the `meta.json` for a recording inside the user's recordings dir
 * and return the fields we care about for ingestion. Missing folder, unreadable
 * file, or malformed JSON returns a stub with `raw: null` and a warning.
 */
export async function readMetaContext(
  recordingsDir: string,
  folderName: string,
): Promise<MetaContext> {
  const folder = join(recordingsDir, folderName);
  const metaPath = join(folder, "meta.json");
  const audioPath = join(folder, "output.wav");
  const hasAudio = existsSync(audioPath);
  const ctx: MetaContext = {
    metaPath,
    audioPath: hasAudio ? audioPath : null,
    hasAudio,
    language: null,
    appName: null,
    appCategory: null,
    raw: null,
  };
  if (!existsSync(metaPath)) {
    verbose(`meta.json missing for ${folderName}`);
    return ctx;
  }
  try {
    const text = await readFile(metaPath, "utf8");
    const json: unknown = JSON.parse(text);
    const parsed = MetaJsonSchema.parse(json);
    ctx.raw = parsed;
    const pc = parsed.promptContext;
    if (pc) {
      ctx.language = pc.modeContext?.language ?? null;
      ctx.appName = pc.applicationContext?.name ?? null;
      ctx.appCategory = pc.applicationContext?.category ?? null;
    }
  } catch (e) {
    warn(`meta.json unreadable for ${folderName}: ${errorMessage(e)}`);
  }
  return ctx;
}

/** mtime of the source DB file in ns precision (or null if missing). */
export function sourceDbMtimeNs(path: string): bigint | null {
  if (!existsSync(path)) return null;
  const s = statSync(path, { bigint: true });
  return s.mtimeNs;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
