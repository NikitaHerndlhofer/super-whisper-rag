import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openArchive } from "../src/archive/open.ts";
import {
  markSourceDeletions,
  refreshAudioLiveness,
} from "../src/ingest/deletions.ts";
import { queryOne } from "./helpers.ts";

const SourceDeletedRowSchema = z.object({
  source_deleted_at: z.string().nullable(),
});

const AudioStateRowSchema = z.object({
  has_audio: z.union([z.literal(0), z.literal(1)]),
  source_audio_lost_at: z.string().nullable(),
});

function tempArchive(): string {
  const dir = mkdtempSync(join(tmpdir(), "swrag-del-"));
  return join(dir, "swrag.sqlite");
}

describe("deletions", () => {
  test("markSourceDeletions only marks rows missing both source row and meta.json", () => {
    const path = tempArchive();
    const fakeMeta = mkdtempSync(join(tmpdir(), "swrag-meta-"));
    mkdirSync(fakeMeta, { recursive: true });
    const aliveMeta = join(fakeMeta, "alive.json");
    Bun.write(aliveMeta, "{}");
    const goneMeta = join(fakeMeta, "gone-but-meta-here.json");
    Bun.write(goneMeta, "{}");
    const missingMeta = join(fakeMeta, "really-gone.json");

    const db = openArchive(path);
    db.exec(
      "INSERT INTO recording (folder_name, recording_id_hex, datetime, duration_ms, mode_name, indexed_at, meta_path) " +
        `VALUES ('alive', 'a', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00', '${aliveMeta}'),
                ('gone-but-meta-here', 'b', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00', '${goneMeta}'),
                ('really-gone', 'c', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00', '${missingMeta}')`,
    );
    const n = markSourceDeletions(
      db,
      new Set(["alive"]),
      "2026-05-18T20:00:00",
    );
    expect(n).toBe(1);

    const reallyGone = queryOne(
      db,
      SourceDeletedRowSchema,
      "SELECT source_deleted_at FROM recording WHERE folder_name = ?",
      "really-gone",
    );
    expect(reallyGone.source_deleted_at).toBe("2026-05-18T20:00:00");

    const alive = queryOne(
      db,
      SourceDeletedRowSchema,
      "SELECT source_deleted_at FROM recording WHERE folder_name = ?",
      "alive",
    );
    expect(alive.source_deleted_at).toBeNull();

    const partial = queryOne(
      db,
      SourceDeletedRowSchema,
      "SELECT source_deleted_at FROM recording WHERE folder_name = ?",
      "gone-but-meta-here",
    );
    expect(partial.source_deleted_at).toBeNull();
    db.close();
  });

  test("refreshAudioLiveness flips has_audio when files vanish", () => {
    const path = tempArchive();
    const audioDir = mkdtempSync(join(tmpdir(), "swrag-audio-"));
    const alivePath = join(audioDir, "alive.wav");
    Bun.write(alivePath, Buffer.alloc(4));
    const gonePath = join(audioDir, "gone.wav");

    const db = openArchive(path);
    db.exec(
      `INSERT INTO recording (folder_name, recording_id_hex, datetime, duration_ms, mode_name,
                              indexed_at, meta_path, audio_path, has_audio)
       VALUES ('alive', 'a', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00',
               '/tmp/m1.json', '${alivePath}', 1),
              ('gone', 'b', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00',
               '/tmp/m2.json', '${gonePath}', 1)`,
    );
    const changed = refreshAudioLiveness(db, "2026-05-18T20:00:00");
    expect(changed).toBe(1);

    const gone = queryOne(
      db,
      AudioStateRowSchema,
      "SELECT has_audio, source_audio_lost_at FROM recording WHERE folder_name = ?",
      "gone",
    );
    expect(gone.has_audio).toBe(0);
    expect(gone.source_audio_lost_at).toBe("2026-05-18T20:00:00");
    db.close();
  });
});
