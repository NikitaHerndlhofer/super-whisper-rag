import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { z } from "zod";

const DeletionCandidateSchema = z.object({
  folder_name: z.string(),
  meta_path: z.string(),
});

const AudioRowSchema = z.object({
  folder_name: z.string(),
  audio_path: z.string().nullable(),
  has_audio: z.union([z.literal(0), z.literal(1)]),
  source_audio_lost_at: z.string().nullable(),
});

/**
 * Mark archive rows as "deleted from source" when their source row has
 * vanished from Super Whisper AND the meta.json on disk is also gone.
 *
 * We require both signals to avoid false positives during a Super Whisper
 * crash window where the SQL row may be gone but the on-disk recording
 * folder still exists (or vice versa).
 */
export function markSourceDeletions(
  archive: Database,
  sourceFolderNames: Set<string>,
  nowIso: string,
): number {
  const select = archive.prepare(
    "SELECT folder_name, meta_path FROM recording WHERE source_deleted_at IS NULL",
  );
  const update = archive.prepare(
    "UPDATE recording SET source_deleted_at = ? WHERE folder_name = ?",
  );
  let n = 0;
  const tx = archive.transaction(() => {
    const rows: unknown[] = select.all();
    for (const raw of rows) {
      const row = DeletionCandidateSchema.parse(raw);
      if (sourceFolderNames.has(row.folder_name)) continue;
      if (row.meta_path && existsSync(row.meta_path)) continue;
      update.run(nowIso, row.folder_name);
      n++;
    }
  });
  tx();
  return n;
}

/**
 * Refresh `has_audio` and set `source_audio_lost_at` for rows whose audio
 * file has disappeared since the last sync. Audio that reappears is also
 * re-armed.
 */
export function refreshAudioLiveness(archive: Database, nowIso: string): number {
  const select = archive.prepare(
    "SELECT folder_name, audio_path, has_audio, source_audio_lost_at FROM recording",
  );
  const setLost = archive.prepare(
    "UPDATE recording SET has_audio = 0, source_audio_lost_at = ? WHERE folder_name = ?",
  );
  const setFound = archive.prepare(
    "UPDATE recording SET has_audio = 1, source_audio_lost_at = NULL WHERE folder_name = ?",
  );
  let changed = 0;
  const tx = archive.transaction(() => {
    const rows: unknown[] = select.all();
    for (const raw of rows) {
      const r = AudioRowSchema.parse(raw);
      const hasFile = !!r.audio_path && existsSync(r.audio_path);
      if (!hasFile && r.has_audio === 1) {
        setLost.run(nowIso, r.folder_name);
        changed++;
      } else if (hasFile && r.has_audio === 0 && r.source_audio_lost_at != null) {
        setFound.run(r.folder_name);
        changed++;
      }
    }
  });
  tx();
  return changed;
}
