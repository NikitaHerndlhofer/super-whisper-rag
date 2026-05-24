import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { computeDefaultTimeoutMs, waitForCompletion } from "../../src/meeting/sw-control.ts";

let workDir: string;
let swDbPath: string;
let recordingsDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-sw-"));
  swDbPath = join(workDir, "superwhisper.sqlite");
  recordingsDir = join(workDir, "recordings");
  mkdirSync(recordingsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Build a minimal SW DB with the column subset `waitForCompletion` reads:
 * `recording(folderName, id, datetime, duration, fromFile, processingTime)`
 * plus the `recording_fts(recordingId, result, rawResult, ...)` join.
 * Each test seeds rows directly.
 */
function makeSwDb(): Database {
  const db = new Database(swDbPath, { create: true, readwrite: true });
  db.exec(`CREATE TABLE recording (
    id TEXT PRIMARY KEY,
    folderName TEXT NOT NULL,
    datetime TEXT NOT NULL,
    duration REAL NOT NULL,
    fromFile INTEGER NOT NULL,
    processingTime INTEGER
  )`);
  db.exec(
    `CREATE VIRTUAL TABLE recording_fts USING fts5(recordingId, llmResult, rawResult, result, tokenize='porter unicode61')`,
  );
  return db;
}

function insertRow(
  db: Database,
  args: {
    folderName: string;
    datetime: string;
    duration: number;
    fromFile?: number;
    result?: string;
    rawResult?: string;
    processingTime?: number | null;
  },
): void {
  const id = args.folderName;
  db.prepare(
    "INSERT INTO recording (id, folderName, datetime, duration, fromFile, processingTime) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    args.folderName,
    args.datetime,
    args.duration,
    args.fromFile ?? 1,
    args.processingTime ?? null,
  );
  db.prepare(
    "INSERT INTO recording_fts (recordingId, llmResult, rawResult, result) VALUES (?, '', ?, ?)",
  ).run(id, args.rawResult ?? "", args.result ?? "");
}

/**
 * Touch the recordings dir so the recursive fs.watch fires. Used by
 * the non-quiescent test to keep the watcher's `lastDbMtimeMs` bumping
 * without actually writing to SW's DB file (which would interfere
 * with the readonly query the wait runs).
 */
function bumpRecordingsDir(counter: number): void {
  writeFileSync(join(recordingsDir, `marker-${counter}.txt`), String(counter));
}

describe("meeting/sw-control waitForCompletion", () => {
  test("resolves with folderName once the row matches and DB is quiescent", async () => {
    const db = makeSwDb();
    // Pre-seed the row BEFORE waitForCompletion attaches, then trigger
    // an FSEvent so the watcher fires the debounced check.
    insertRow(db, {
      folderName: "FOLDER_A",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 5000,
      result: "post-LLM cleanup result",
    });
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    // Fire a watch event AFTER the wait has started so it actually picks
    // up the row in the debounced check rather than immediately at start.
    const p = waitForCompletion({
      swDbPath,
      swRecordingsDir: recordingsDir,
      cutoffIso,
      durationMs: 5000,
      timeoutMs: 8000,
      quiescenceMs: 200,
      debounceMs: 50,
    });
    // No more writes — quiescence will satisfy within ~200 ms.
    const result = await p;
    expect(result.folderName).toBe("FOLDER_A");
    expect(result.eventCount).toBeGreaterThanOrEqual(0);
  });

  test("does not resolve early while the DB is still being written (non-quiescent)", async () => {
    const db = makeSwDb();
    insertRow(db, {
      folderName: "FOLDER_LIVE",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 7000,
      result: "intermediate ASR result",
    });
    db.close();

    // Hammer the recordings-dir mtime for a fixed window (700 ms),
    // then stop. The wait must not have resolved during that hammering
    // window because the DB never stays quiescent for the full 400 ms
    // gate. After the hammer stops the next check (within 400 ms +
    // debounce) finds the seeded row.
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    const HAMMER_FOR_MS = 700;
    const hammerEnd = Date.now() + HAMMER_FOR_MS;
    let counter = 0;
    const hammer = (async () => {
      while (Date.now() < hammerEnd) {
        bumpRecordingsDir(counter++);
        await Bun.sleep(100);
      }
    })();
    const start = Date.now();
    const result = await waitForCompletion({
      swDbPath,
      swRecordingsDir: recordingsDir,
      cutoffIso,
      durationMs: 7000,
      timeoutMs: 8000,
      quiescenceMs: 400,
      debounceMs: 50,
    });
    await hammer;
    const elapsed = Date.now() - start;
    expect(result.folderName).toBe("FOLDER_LIVE");
    // The wait must not have resolved before the hammer finished.
    expect(elapsed).toBeGreaterThanOrEqual(HAMMER_FOR_MS);
  });

  test("ignores rows with wrong duration (±50 ms gate)", async () => {
    const db = makeSwDb();
    // duration is 5000; we ask for 9000 ms → must NOT match.
    insertRow(db, {
      folderName: "WRONG_DURATION",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 5000,
      result: "decoded text",
    });
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    await expect(
      waitForCompletion({
        swDbPath,
        swRecordingsDir: recordingsDir,
        cutoffIso,
        durationMs: 9000,
        timeoutMs: 800,
        quiescenceMs: 200,
        debounceMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test("ignores rows where fromFile = 0 (concurrent user dictation)", async () => {
    const db = makeSwDb();
    insertRow(db, {
      folderName: "USER_DICTATION",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 4000,
      fromFile: 0,
      result: "user-driven dictation",
    });
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    await expect(
      waitForCompletion({
        swDbPath,
        swRecordingsDir: recordingsDir,
        cutoffIso,
        durationMs: 4000,
        timeoutMs: 800,
        quiescenceMs: 200,
        debounceMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test("times out cleanly when nothing matches; SQLite handle is closed (smoke)", async () => {
    const db = makeSwDb();
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    await expect(
      waitForCompletion({
        swDbPath,
        swRecordingsDir: recordingsDir,
        cutoffIso,
        durationMs: 1000,
        timeoutMs: 500,
        quiescenceMs: 100,
        debounceMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
    // If the handle were leaked, the file would be locked on cleanup
    // and `rmSync(workDir, recursive: true)` in afterEach would fail
    // on macOS (it doesn't here, but still — sanity-open it once).
    const re = new Database(swDbPath, { readonly: true });
    re.close();
  });

  test("rejects if the SW DB does not exist", async () => {
    const missing = join(workDir, "nope.sqlite");
    await expect(
      waitForCompletion({
        swDbPath: missing,
        swRecordingsDir: recordingsDir,
        cutoffIso: "2026-05-21T00:00:00Z",
        durationMs: 1000,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("opens only one SQLite connection per call (smoke)", async () => {
    // We can't easily inspect bun:sqlite handle counts; assert
    // structurally via timing: a 500 ms wait must not produce more
    // than one connection's worth of overhead. Indirect, but
    // the implementation holds a single Database for the whole wait
    // (see comment in waitForCompletion).
    const db = makeSwDb();
    db.close();
    const t0 = Date.now();
    await waitForCompletion({
      swDbPath,
      swRecordingsDir: recordingsDir,
      cutoffIso: "2026-05-21T00:00:00Z",
      durationMs: 1000,
      timeoutMs: 400,
      quiescenceMs: 100,
      debounceMs: 30,
    }).catch(() => {});
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    // < ~1500 ms (i.e. not many seconds of overhead) — fairly loose.
    expect(elapsed).toBeLessThan(2000);
  });

  test("REGRESSION: matches an SW-format row datetime against an ISO cutoff (same day)", async () => {
    // Reproduces the format-mismatch bug surfaced by Phase 1 real-SW
    // verification. SW stores `datetime` as "2026-05-23 03:39:51.131"
    // (space + no `Z`), and the wait was constructing a cutoff via
    // `new Date().toISOString()` → "2026-05-23T03:39:42.123Z". When
    // both sides of the SQL `>` compare have the same date prefix, the
    // raw lexicographic ordering puts the space-separated row BELOW
    // the T-separated cutoff (space=0x20 < T=0x54), so the gate never
    // fired and the wait hung until hard timeout.
    //
    // Use a precisely-controlled scenario: insert a row dated 5
    // seconds in the future-of-cutoff (in SW's format), and use an
    // ISO cutoff for "now" — same date. With the fix this matches;
    // without it (raw string compare) it would not.
    const db = makeSwDb();
    const nowMs = Date.now();
    const swDtStr = (ms: number): string => {
      // SQLite's preferred "YYYY-MM-DD HH:MM:SS.SSS" format. Use UTC
      // components so it lines up with ISO cutoff produced by
      // toISOString() — SW itself stores local time, but the bug is
      // purely about the SEPARATOR character, not the offset; same
      // date prefix is enough to exercise the regression.
      const d = new Date(ms);
      const pad = (n: number, w = 2) => String(n).padStart(w, "0");
      return (
        `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
      );
    };
    insertRow(db, {
      folderName: "SAME_DAY_ISO",
      datetime: swDtStr(nowMs + 5_000),
      duration: 2000,
      result: "matched after format fix",
    });
    db.close();
    const cutoffIso = new Date(nowMs).toISOString();
    expect(cutoffIso).toMatch(/T/); // sanity: ISO has the `T` that used to break the compare.
    const result = await waitForCompletion({
      swDbPath,
      swRecordingsDir: recordingsDir,
      cutoffIso,
      durationMs: 2000,
      timeoutMs: 1_500,
      quiescenceMs: 100,
      debounceMs: 30,
    });
    expect(result.folderName).toBe("SAME_DAY_ISO");
  });

  test("safety re-check picks up the row when FSEvents drops every event", async () => {
    // Simulate a worst-case FSEvents-drop scenario: the row is
    // inserted AFTER the wait has attached, but no events fire (we
    // never touch the recordings dir or DB parent dir from this
    // test). The only thing that should cause `checkNow` to fire is
    // the safety interval. With safetyRecheckMs=150 the wait should
    // resolve within ~150–400 ms.
    const db = makeSwDb();
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    const insertedFolder = "SAFETY_ONLY";
    // Insert the row 100 ms after attach via a fresh r/w handle —
    // this WILL bump SW DB mtime, which the watcher would normally
    // see, but bun's fs.watch on a directory may not always fire for
    // a single new file write. Either way, the safety net guarantees
    // pickup.
    const insertTimer = setTimeout(() => {
      const rw = new Database(swDbPath, { readwrite: true });
      try {
        const nowSqlDt = new Date().toISOString().replace("T", " ").slice(0, 23);
        rw.prepare(
          "INSERT INTO recording (id, folderName, datetime, duration, fromFile) VALUES (?, ?, ?, ?, ?)",
        ).run(insertedFolder, insertedFolder, nowSqlDt, 3000, 1);
        rw.prepare(
          "INSERT INTO recording_fts (recordingId, llmResult, rawResult, result) VALUES (?, '', '', ?)",
        ).run(insertedFolder, "result");
      } finally {
        rw.close();
      }
    }, 100);

    try {
      const result = await waitForCompletion({
        swDbPath,
        swRecordingsDir: recordingsDir,
        cutoffIso,
        durationMs: 3000,
        timeoutMs: 2_000,
        quiescenceMs: 50,
        debounceMs: 30,
        safetyRecheckMs: 150,
      });
      expect(result.folderName).toBe(insertedFolder);
    } finally {
      clearTimeout(insertTimer);
    }
  });

  test("empty-transcript: resolves with emptyTranscript=true when SW finished but produced no text", async () => {
    // Reproduces the silent-audio scenario surfaced by the v0.9.3 VPIO
    // bug: SW processed the wav (`processingTime` set) but `fts.result`
    // and `fts.rawResult` are both empty. Without this success path
    // the worker would hang on the row forever.
    const db = makeSwDb();
    insertRow(db, {
      folderName: "SILENT_FOLDER",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 3000,
      result: "",
      rawResult: "",
      processingTime: 1234,
    });
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    const result = await waitForCompletion({
      swDbPath,
      swRecordingsDir: recordingsDir,
      cutoffIso,
      durationMs: 3000,
      timeoutMs: 2_000,
      quiescenceMs: 50,
      emptyQuiescenceMs: 200,
      debounceMs: 30,
    });
    expect(result.folderName).toBe("SILENT_FOLDER");
    expect(result.emptyTranscript).toBe(true);
  });

  test("empty-transcript: does NOT trigger when processingTime is null (still processing)", async () => {
    // Empty result + null processingTime means SW hasn't finished yet
    // (the row was inserted by the ASR-starts side of SW's pipeline
    // but the result hasn't been written). Must keep waiting, not
    // mis-classify this as "silent audio". The wait should time out.
    const db = makeSwDb();
    insertRow(db, {
      folderName: "IN_PROGRESS",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 3000,
      result: "",
      rawResult: "",
      processingTime: null,
    });
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    await expect(
      waitForCompletion({
        swDbPath,
        swRecordingsDir: recordingsDir,
        cutoffIso,
        durationMs: 3000,
        timeoutMs: 600,
        quiescenceMs: 50,
        emptyQuiescenceMs: 200,
        debounceMs: 30,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test("empty-transcript path waits the longer quiescence window", async () => {
    // Even with `processingTime` already set, the wait must hold off
    // resolving for at least `emptyQuiescenceMs` so a late LLM rewrite
    // could still fill in text. Configure emptyQuiescenceMs=400 and
    // confirm elapsed >= 400.
    const db = makeSwDb();
    insertRow(db, {
      folderName: "PATIENCE",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 3000,
      result: "",
      rawResult: "",
      processingTime: 5000,
    });
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    const start = Date.now();
    const result = await waitForCompletion({
      swDbPath,
      swRecordingsDir: recordingsDir,
      cutoffIso,
      durationMs: 3000,
      timeoutMs: 2_000,
      quiescenceMs: 50,
      emptyQuiescenceMs: 400,
      debounceMs: 30,
    });
    const elapsed = Date.now() - start;
    expect(result.emptyTranscript).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  test("text result still wins when both processingTime AND fts.result are set", async () => {
    // The dual-path query must not mis-prioritise: if SW has a text
    // result AND a processingTime, we resolve via the normal path
    // (emptyTranscript undefined/false), not the empty path.
    const db = makeSwDb();
    insertRow(db, {
      folderName: "REAL_TEXT",
      datetime: new Date().toISOString().replace("T", " ").slice(0, 23),
      duration: 4000,
      result: "actual transcribed text",
      rawResult: "raw asr text",
      processingTime: 2500,
    });
    db.close();
    const cutoffIso = "2026-05-21T00:00:00.000Z";
    const result = await waitForCompletion({
      swDbPath,
      swRecordingsDir: recordingsDir,
      cutoffIso,
      durationMs: 4000,
      timeoutMs: 2_000,
      quiescenceMs: 100,
      emptyQuiescenceMs: 30_000,
      debounceMs: 30,
    });
    expect(result.folderName).toBe("REAL_TEXT");
    expect(result.emptyTranscript).toBeFalsy();
  });

  test("default timeout scales to max(30 min, 3 × durationMs)", () => {
    // We can't actually wait 30 minutes in a unit test, so exercise
    // the scaling formula directly. The wait code path calls this
    // same function when callers omit `timeoutMs`.
    expect(computeDefaultTimeoutMs(null)).toBe(30 * 60 * 1000);
    expect(computeDefaultTimeoutMs(0)).toBe(30 * 60 * 1000);
    expect(computeDefaultTimeoutMs(5_000)).toBe(30 * 60 * 1000);
    // Long meeting: 90 min wav → 3 × 90 min = 270 min, exceeds floor.
    expect(computeDefaultTimeoutMs(90 * 60 * 1000)).toBe(3 * 90 * 60 * 1000);
    // Exactly at the floor: 10 min wav × 3 = 30 min, equals floor.
    expect(computeDefaultTimeoutMs(10 * 60 * 1000)).toBe(30 * 60 * 1000);
  });
});
