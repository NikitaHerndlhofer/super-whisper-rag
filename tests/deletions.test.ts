import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import { openArchive } from "../src/archive/open.ts";
import { markSourceDeletions, refreshAudioLiveness } from "../src/ingest/deletions.ts";
import { queryOne } from "./helpers.ts";

const SourceDeletedRowSchema = z.object({
  source_deleted_at: z.string().nullable(),
});

const AudioStateRowSchema = z.object({
  has_audio: z.union([z.literal(0), z.literal(1)]),
  source_audio_lost_at: z.string().nullable(),
});

// Track every temp dir we create so afterEach can tear them down. The
// previous version of this file leaked mkdtempSync dirs under
// /var/folders/.../T on every run.
const createdDirs: string[] = [];

function tempArchive(): string {
  const dir = mkdtempSync(join(tmpdir(), "swrag-del-"));
  createdDirs.push(dir);
  return join(dir, "swrag.sqlite");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("deletions", () => {
  test("markSourceDeletions only marks rows missing both source row and meta.json", () => {
    const path = tempArchive();
    const fakeMeta = tempDir("swrag-meta-");
    mkdirSync(fakeMeta, { recursive: true });
    const aliveMeta = join(fakeMeta, "alive.json");
    writeFileSync(aliveMeta, "{}");
    const goneMeta = join(fakeMeta, "gone-but-meta-here.json");
    writeFileSync(goneMeta, "{}");
    const missingMeta = join(fakeMeta, "really-gone.json");

    // openArchive doesn't create the parent dir of the archive path
    // unless it exists; tempArchive returns <tmpdir>/<random>/swrag.sqlite
    // so we need to ensure <random>/ exists. (It does — mkdtempSync
    // already created it — but stay defensive.)
    mkdirSync(dirname(path), { recursive: true });
    const db = openArchive(path);
    db.exec(
      "INSERT INTO recording (folder_name, recording_id_hex, datetime, duration_ms, mode_name, indexed_at, meta_path) " +
        `VALUES ('alive', 'a', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00', '${aliveMeta}'),
                ('gone-but-meta-here', 'b', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00', '${goneMeta}'),
                ('really-gone', 'c', '2026-01-01T00:00:00', 1000, 'Universal', '2026-01-01T00:00:00', '${missingMeta}')`,
    );
    const n = markSourceDeletions(db, new Set(["alive"]), "2026-05-18T20:00:00");
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
    const audioDir = tempDir("swrag-audio-");
    const alivePath = join(audioDir, "alive.wav");
    writeFileSync(alivePath, Buffer.alloc(4));
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
