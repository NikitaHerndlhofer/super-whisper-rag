import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, openArchive } from "../../src/archive/open.ts";
import {
  EMPTY_TRANSCRIPT_ERROR,
  LOST_IN_TRANSIT_ERROR,
  MEETING_QUEUE_STATE_KEY,
  MeetingProcessor,
  readState,
  type ProcessorHooks,
} from "../../src/meeting/processor.ts";
import { countPending, enqueue, getById, list, markTranscribing } from "../../src/meeting/queue.ts";

let workDir: string;
let archive: string;
let sourceDir: string;
let sourceDb: string;
let recordingsDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-proc-"));
  archive = join(workDir, "archive.sqlite");
  sourceDir = join(workDir, "superwhisper");
  sourceDb = join(workDir, "sw.sqlite");
  recordingsDir = join(sourceDir, "recordings");
  mkdirSync(recordingsDir, { recursive: true });
  // Build a minimal SW-shaped DB so the processor's crash-recovery
  // cross-check query has the tables it expects. Tests that need
  // actual rows seed them via direct INSERT inside the test body.
  const sdb = new Database(sourceDb, { create: true, readwrite: true });
  sdb.exec(`CREATE TABLE recording (
    id TEXT PRIMARY KEY,
    folderName TEXT NOT NULL,
    datetime TEXT NOT NULL,
    duration REAL NOT NULL DEFAULT 0,
    fromFile INTEGER NOT NULL DEFAULT 1,
    appVersion TEXT
  )`);
  sdb.exec(
    `CREATE VIRTUAL TABLE recording_fts USING fts5(recordingId, llmResult, rawResult, result, tokenize='porter unicode61')`,
  );
  sdb.close();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeWav(path: string, content = "fake-wav"): void {
  writeFileSync(path, content);
}

function freshProcessorOpts(hooks: ProcessorHooks = {}) {
  return {
    archive,
    sourceDir,
    sourceDb,
    swDbPath: sourceDb,
    swRecordingsDir: recordingsDir,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    keepAudio: true,
    completionTimeoutMs: 1000,
    hooks,
  };
}

function withDb<T>(fn: (db: ReturnType<typeof openArchive>) => T): T {
  const db = openArchive(archive, {});
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Build the standard set of stub hooks for a test that wants the
 * worker loop to succeed end-to-end without touching SW. Each hook is
 * minimal:
 *   - ingestFile: instant resolve
 *   - waitForCompletion: instant resolve with the supplied folderName
 *   - patcher: no-op patch + close
 *   - runIndexFolder: no-op
 */
function happyHooks(folderName: string): ProcessorHooks {
  return {
    ingestFile: async () => {},
    waitForCompletion: async () => ({ folderName }),
    makePatcher: () => ({
      patch: async (f: string, d: string) => ({
        folderName: f,
        capturedAt: d,
        swAppVersion: null,
        versionWarned: false,
        attempts: 1,
      }),
      close: () => {},
    }),
    runIndexFolder: async (o) => ({
      folderName: o.folderName,
      existed: false,
      embedded: 0,
      superseded: 0,
      durationMs: 0,
    }),
  };
}

describe("MeetingProcessor — state machine", () => {
  test("default state is paused", () => {
    expect(readState(archive)).toBe("paused");
  });

  test("start drains the queue, deletes completed rows, lands at paused", async () => {
    // v0.9.1 policy: a successfully processed row is DELETED from
    // meeting_queue. The archive's `recording` table holds the
    // canonical transcript after runIndexFolder returns, so the
    // queue row is just operational state worth garbage-collecting.
    const wavA = join(workDir, "a.wav");
    const wavB = join(workDir, "b.wav");
    writeWav(wavA);
    writeWav(wavB);
    let aId = 0;
    let bId = 0;
    withDb((db) => {
      aId = enqueue(db, {
        audio_path: wavA,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      }).id;
      bId = enqueue(db, {
        audio_path: wavB,
        captured_at: "2026-05-22T01:00:00Z",
        duration_ms: 1000,
      }).id;
    });

    const processedOrder: string[] = [];
    const hooks = happyHooks("FOLDER_X");
    hooks.waitForCompletion = async () => {
      processedOrder.push("wait");
      return { folderName: "FOLDER_X" };
    };
    hooks.ingestFile = async (path: string) => {
      processedOrder.push(`ingest:${path === wavA ? "A" : "B"}`);
    };

    const processor = new MeetingProcessor(freshProcessorOpts(hooks));
    await processor.recoverTranscribingRows();
    await processor.start();

    expect(readState(archive)).toBe("paused");
    expect(processedOrder).toEqual(["ingest:A", "wait", "ingest:B", "wait"]);
    withDb((db) => {
      expect(countPending(db)).toBe(0);
      expect(list(db, { status: "completed" }).length).toBe(0);
      expect(list(db).length).toBe(0);
      expect(getById(db, aId)).toBeNull();
      expect(getById(db, bId)).toBeNull();
    });
  });

  test("FIFO order: items are processed by captured_at", async () => {
    const wavLate = join(workDir, "late.wav");
    const wavEarly = join(workDir, "early.wav");
    writeWav(wavLate);
    writeWav(wavEarly);
    const order: number[] = [];
    withDb((db) => {
      const late = enqueue(db, {
        audio_path: wavLate,
        captured_at: "2026-05-22T05:00:00Z",
        duration_ms: 1000,
        label: "late",
      });
      const early = enqueue(db, {
        audio_path: wavEarly,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
        label: "early",
      });
      order.push(early.id, late.id);
    });

    const hooks = happyHooks("F");
    const seenLabels: string[] = [];
    hooks.ingestFile = async (path: string) => {
      seenLabels.push(path === wavEarly ? "early" : "late");
    };
    const processor = new MeetingProcessor(freshProcessorOpts(hooks));
    await processor.start();
    expect(seenLabels).toEqual(["early", "late"]);
  });

  test("failure on one item does not block the queue", async () => {
    const wavBad = join(workDir, "bad.wav");
    const wavGood = join(workDir, "good.wav");
    writeWav(wavBad);
    writeWav(wavGood);
    let badId = 0;
    let goodId = 0;
    withDb((db) => {
      badId = enqueue(db, {
        audio_path: wavBad,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      }).id;
      goodId = enqueue(db, {
        audio_path: wavGood,
        captured_at: "2026-05-22T01:00:00Z",
        duration_ms: 1000,
      }).id;
    });

    const hooks = happyHooks("F");
    hooks.ingestFile = async (path: string) => {
      if (path === wavBad) throw new Error("simulated SW launch failure");
    };
    const processor = new MeetingProcessor(freshProcessorOpts(hooks));
    await processor.start();
    withDb((db) => {
      // v0.9.1: the failed row stays for diagnosability, the good
      // row is deleted (canonical transcript lives in the archive).
      const bad = getById(db, badId);
      const good = getById(db, goodId);
      expect(bad?.status).toBe("failed");
      expect(bad?.error).toContain("simulated SW launch failure");
      expect(good).toBeNull();
    });
  });

  test("persistence across simulated restart: 'processing' state survives", async () => {
    // Manually flip state to 'processing' as if a crashed daemon left it
    // there. Constructing a fresh processor and calling start should
    // resume the loop and drain the (empty) queue, landing back at paused.
    withDb((db) => {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
        MEETING_QUEUE_STATE_KEY,
        "processing",
      );
    });
    const processor = new MeetingProcessor(freshProcessorOpts(happyHooks("F")));
    await processor.start();
    expect(readState(archive)).toBe("paused");
  });

  test("crash recovery: transcribing row gets marked failed when SW lacks the folder", async () => {
    const wav = join(workDir, "x.wav");
    writeWav(wav);
    let rowId = 0;
    withDb((db) => {
      const row = enqueue(db, {
        audio_path: wav,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      });
      rowId = row.id;
      markTranscribing(db, row.id);
    });
    const processor = new MeetingProcessor(freshProcessorOpts(happyHooks("F")));
    await processor.recoverTranscribingRows();
    withDb((db) => {
      const cur = getById(db, rowId);
      expect(cur?.status).toBe("failed");
      expect(cur?.error).toBe(LOST_IN_TRANSIT_ERROR);
    });
  });

  test("crash recovery: completes transcribing row when SW has the folder ready", async () => {
    // Seed the SW DB with a matching row + fts entry on top of the
    // beforeEach baseline.
    {
      const sdb = new Database(sourceDb, { readwrite: true });
      sdb
        .prepare(
          "INSERT INTO recording (id, folderName, datetime, duration, fromFile) VALUES (?, ?, ?, ?, ?)",
        )
        .run("SWFOLDER", "SWFOLDER", "2026-05-22T00:00:00Z", 1000, 1);
      sdb
        .prepare(
          "INSERT INTO recording_fts (recordingId, llmResult, rawResult, result) VALUES (?, '', '', ?)",
        )
        .run("SWFOLDER", "hello world from SW");
      sdb.close();
    }
    const wav = join(workDir, "x.wav");
    writeWav(wav);
    let rowId = 0;
    withDb((db) => {
      const row = enqueue(db, {
        audio_path: wav,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      });
      rowId = row.id;
      // Pretend we got far enough to record the SW folder before crashing.
      db.prepare("UPDATE meeting_queue SET status='transcribing', sw_folder_name=? WHERE id=?").run(
        "SWFOLDER",
        row.id,
      );
    });
    const hooks = happyHooks("SWFOLDER");
    // Default `freshProcessorOpts` sets keepAudio=true for the other
    // tests in this file (they don't care). For the recovery test we
    // want production behavior: the wav should be unlinked on success.
    const opts = { ...freshProcessorOpts(hooks), keepAudio: false };
    const processor = new MeetingProcessor(opts);
    await processor.recoverTranscribingRows();
    withDb((db) => {
      // v0.9.1: recovery uses the same markCompletedSafe path as the
      // happy loop, which DELETES the row after a successful
      // patch+index. The recording lives in the archive's
      // `recording` table at this point.
      const cur = getById(db, rowId);
      expect(cur).toBeNull();
    });
    // Recovery should also clean up the wav (matching processOne's
    // behavior) — otherwise meetings/incoming/ accumulates orphaned
    // files across crashes.
    expect(existsSync(wav)).toBe(false);
  });

  test("discard refuses currently-processing item, succeeds otherwise; row + wav both vanish", async () => {
    // v0.9.1: a successful discard DELETES the queue row outright
    // (no more "discarded by user" sentinel-error rows). The
    // currently-processing item is still refused; an unknown id
    // is still refused.
    const wavA = join(workDir, "a.wav");
    const wavB = join(workDir, "b.wav");
    writeWav(wavA);
    writeWav(wavB);
    let aId = 0;
    let bId = 0;
    withDb((db) => {
      aId = enqueue(db, {
        audio_path: wavA,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      }).id;
      bId = enqueue(db, {
        audio_path: wavB,
        captured_at: "2026-05-22T01:00:00Z",
        duration_ms: 1000,
      }).id;
    });
    const processor = new MeetingProcessor(freshProcessorOpts(happyHooks("F")));
    // Discard B before starting → ok; row + wav both vanish.
    const r1 = processor.discard(bId);
    expect(r1.ok).toBe(true);
    withDb((db) => {
      expect(getById(db, bId)).toBeNull();
    });
    expect(existsSync(wavB)).toBe(false);
    // Re-discarding the same id is now a "no row" failure (we
    // refuse to invent state).
    const r1again = processor.discard(bId);
    expect(r1again.ok).toBe(false);
    // Discard non-existent → fail.
    const r2 = processor.discard(99999);
    expect(r2.ok).toBe(false);
    await processor.start();
    withDb((db) => {
      // A: processed-then-deleted. B: discarded-then-deleted.
      expect(getById(db, aId)).toBeNull();
      expect(getById(db, bId)).toBeNull();
    });
  });

  test("state snapshot reflects current_item during processing", async () => {
    const wav = join(workDir, "a.wav");
    writeWav(wav);
    let rowId = 0;
    withDb((db) => {
      const r = enqueue(db, {
        audio_path: wav,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      });
      rowId = r.id;
    });
    const hooks = happyHooks("F");
    const snap: { value: ReturnType<MeetingProcessor["state"]> | null } = { value: null };
    const procRef: { p: MeetingProcessor | null } = { p: null };
    hooks.waitForCompletion = async () => {
      snap.value = procRef.p?.state() ?? null;
      return { folderName: "F" };
    };
    procRef.p = new MeetingProcessor(freshProcessorOpts(hooks));
    await procRef.p.start();
    expect(snap.value).not.toBeNull();
    expect(snap.value?.state).toBe("processing");
    expect(snap.value?.current_item?.id).toBe(rowId);
    const final = procRef.p.state();
    expect(final.state).toBe("paused");
    expect(final.current_item).toBeNull();
  });

  test("empty-transcript completion marks row failed and skips patch+index", async () => {
    // Reproduces the silent-audio safety net: when `waitForCompletion`
    // resolves with `emptyTranscript: true` (SW finished but produced
    // no text), the processor MUST NOT call patcher.patch or
    // runIndexFolder — there's no transcript to archive — and MUST
    // mark the queue row failed with the sentinel error.
    const wav = join(workDir, "silent.wav");
    writeWav(wav);
    let rowId = 0;
    withDb((db) => {
      rowId = enqueue(db, {
        audio_path: wav,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      }).id;
    });
    let patchCalls = 0;
    let indexCalls = 0;
    const hooks = happyHooks("SILENT_SW_FOLDER");
    hooks.waitForCompletion = async () => ({
      folderName: "SILENT_SW_FOLDER",
      emptyTranscript: true,
    });
    hooks.makePatcher = () => ({
      patch: async (f: string, d: string) => {
        patchCalls++;
        return {
          folderName: f,
          capturedAt: d,
          swAppVersion: null,
          versionWarned: false,
          attempts: 1,
        };
      },
      close: () => {},
    });
    hooks.runIndexFolder = async (o) => {
      indexCalls++;
      return {
        folderName: o.folderName,
        existed: false,
        embedded: 0,
        superseded: 0,
        durationMs: 0,
      };
    };
    // keepAudio=false so we also verify the wav is unlinked.
    const processor = new MeetingProcessor({
      ...freshProcessorOpts(hooks),
      keepAudio: false,
    });
    await processor.start();
    expect(patchCalls).toBe(0);
    expect(indexCalls).toBe(0);
    withDb((db) => {
      const row = getById(db, rowId);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe(EMPTY_TRANSCRIPT_ERROR);
    });
    expect(existsSync(wav)).toBe(false);
  });

  test("config-table state and queue.* survive a 'restart' (close + reopen)", async () => {
    const wav = join(workDir, "a.wav");
    writeWav(wav);
    withDb((db) => {
      enqueue(db, {
        audio_path: wav,
        captured_at: "2026-05-22T00:00:00Z",
        duration_ms: 1000,
      });
    });
    const processor1 = new MeetingProcessor(freshProcessorOpts(happyHooks("F")));
    await processor1.start();
    // Force state corruption to simulate a crash mid-processing.
    withDb((db) => {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
        MEETING_QUEUE_STATE_KEY,
        "pausing",
      );
    });
    expect(readState(archive)).toBe("pausing");

    // New processor instance: reading state with the value 'pausing'
    // should be a valid enum value (we don't auto-coerce here; the
    // worker would transition to 'paused' on next start).
    const processor2 = new MeetingProcessor(freshProcessorOpts(happyHooks("F")));
    expect(processor2.state().state).toBe("pausing");
    // Make sure the persisted config key is what we expect.
    withDb((db) => {
      expect(getConfig(db, MEETING_QUEUE_STATE_KEY)).toBe("pausing");
    });
  });
});
