/**
 * Super Whisper control plane.
 *
 * Two operations, both deliberately small:
 *
 *   1. `ingestFile(path)` — `open -a superwhisper <path>` and return
 *      when the spawn exits. `open` returns immediately after handing
 *      the file to LaunchServices; SW's actual transcription happens
 *      asynchronously inside SW's own process. We don't manage SW's
 *      mode here — that's the user's responsibility, set via SW's UI
 *      before they click `▶ Start queue processing`.
 *
 *   2. `waitForCompletion(...)` — block until SW has finished writing
 *      the row for the file we just dropped in. The completion gate
 *      is **quiescence-based**, not the original plan's
 *      `processingTime IS NOT NULL AND length(rawResult) > 0`:
 *      empirically, that gate fires after SW's ASR step, but for any
 *      mode with an LLM cleanup step SW comes back ~10 s later and
 *      rewrites `datetime` (and the FTS result row). Patching during
 *      that window gets clobbered.
 *
 *      The current gate:
 *        - `length(fts.result) > 0`  → SW has at least filled in the
 *          final post-LLM text (or the ASR text if no LLM step).
 *        - `r.fromFile = 1`          → matches our `open -a` drop-in,
 *          not concurrent user dictations.
 *        - `ABS(r.duration - ?) < 50` ms → disambiguates if the user
 *          manually drops another wav into SW while we're waiting.
 *        - SW DB mtime has not advanced for ≥ 2 s → SW's LLM step
 *          has settled and is no longer rewriting the row.
 *
 *      See docs/sw-patcher-spike.md §"Required Phase 1 design
 *      changes" for the empirical justification.
 *
 * The wait is FSEvents-driven via Bun's `fs.watch` recursive watcher
 * on SW's recordings dir AND on the parent directory of SW's SQLite
 * file. The SQL is only run when an event fires (debounced 300 ms),
 * never on a polling timer. The single read-only SQLite handle is
 * held for the entire wait — opening it per-event would be wasteful
 * and the spike found it added 10–40 ms latency per fire.
 */
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { verbose, warn } from "../log.ts";

const CandidateRowSchema = z.object({
  folderName: z.string(),
  resultLen: z.number(),
  rawResultLen: z.number(),
  // SW writes `processingTime` (INTEGER, milliseconds) once it's done
  // with the file. `null` means SW hasn't finished yet — used to
  // disambiguate "still processing, just no text yet" from "finished
  // and the audio was silent".
  processingTime: z.number().nullable(),
});

const DEFAULT_QUIESCENCE_MS = 2_000;
const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Quiescence window for the empty-transcript success path. Longer
 * than the normal 2 s gate because a silent audio file goes through
 * SW's pipeline atypically — `processingTime` gets set at the end
 * of ASR (~10 s after ingest for a short wav) and we want extra
 * confidence the row won't suddenly grow text. 30 s is well past
 * SW's worst observed LLM-cleanup re-write delay.
 */
const DEFAULT_EMPTY_QUIESCENCE_MS = 30_000;
/**
 * Safety net for dropped FSEvents. macOS occasionally coalesces or
 * outright drops events under load (and Bun's `fs.watch` recursive
 * inherits that ceiling), so we re-run `checkNow` on a slow interval
 * even if no event has fired. Cheap — one SQLite query every 60 s is
 * negligible compared to the wait we're guarding (up to 30+ minutes).
 */
const SAFETY_RECHECK_MS = 60_000;

export interface IngestFileOptions {
  /** For tests: a `Bun.spawn`-shaped function (default: real `Bun.spawn`). */
  spawn?: typeof Bun.spawn;
}

/**
 * Drop the wav into Super Whisper. `open` returns immediately once
 * LaunchServices accepts the file; SW's transcription work runs
 * asynchronously after that. We await `exit` so failures (no SW
 * installed, file path malformed, etc.) surface synchronously to the
 * caller as a non-zero exit code.
 */
export async function ingestFile(path: string, opts: IngestFileOptions = {}): Promise<void> {
  if (!existsSync(path)) {
    throw new Error(`ingestFile: file not found: ${path}`);
  }
  const spawn = opts.spawn ?? Bun.spawn;
  const proc = spawn(["open", "-a", "superwhisper", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = proc.stderr ? await Bun.readableStreamToText(proc.stderr) : "";
    throw new Error(`open -a superwhisper exited ${exit}: ${err.trim()}`);
  }
}

export interface WaitForCompletionOptions {
  /** Path to Super Whisper's SQLite DB. */
  swDbPath: string;
  /** Path to Super Whisper's recordings dir. */
  swRecordingsDir: string;
  /**
   * ISO8601 timestamp; the query filters `recording.datetime > cutoffIso`.
   * The caller should set this to `new Date().toISOString()` immediately
   * before calling `ingestFile` so SW's row (inserted ~0.8 s later) lands
   * strictly newer than the cutoff.
   */
  cutoffIso: string;
  /** Expected duration of the wav in milliseconds. ±50 ms disambiguates. */
  durationMs: number | null;
  /**
   * Hard timeout for the wait. If omitted, defaults to
   * `max(30 min, 3 × durationMs)` when `durationMs` is supplied, else
   * 30 minutes. The 3× scaling protects long meetings — SW transcription
   * latency is roughly linear in audio length and a 90-minute recording
   * easily exceeds 30 minutes wall-clock.
   */
  timeoutMs?: number;
  /** Override the quiescence window length. */
  quiescenceMs?: number;
  /**
   * Override the empty-transcript-path quiescence window. Tests use a
   * short value (e.g. 200 ms) to keep the suite fast; production
   * code leaves this undefined and the 30-second default applies.
   */
  emptyQuiescenceMs?: number;
  /** Override the post-event debounce window. */
  debounceMs?: number;
  /**
   * Override the safety re-check interval (default 60 s). Tests use a
   * short value to exercise the dropped-event path; production code
   * always leaves this undefined.
   */
  safetyRecheckMs?: number;
}

export interface WaitForCompletionResult {
  folderName: string;
  /** Total wait duration in milliseconds, for logging. */
  elapsedMs: number;
  /** Total number of fs.watch fires observed during the wait. */
  eventCount: number;
  /**
   * True if SW finished processing but produced an empty transcript
   * (`processingTime` is set, both `fts.result` and `fts.rawResult`
   * are zero-length). The caller — meeting processor — should treat
   * this as a soft failure (silent audio: mic muted mid-call, audio
   * dropout, VPIO regression) rather than block forever on a row
   * that will never grow text. Default `false`/undefined for the
   * normal success path.
   */
  emptyTranscript?: boolean;
}

interface InternalState {
  lastDbMtimeMs: number;
  lastEventAtMs: number;
  eventCount: number;
  partialMatchSeen: boolean;
}

/**
 * Open SW's SQLite read-only and `fs.watch` SW's recordings dir + DB
 * parent dir. On each filesystem event, debounce 300 ms and check:
 *
 *   1. Has the SW DB file's mtime been stable for ≥ 2 s?
 *   2. Does the SQL query find a matching row?
 *
 * If both are true, resolve with the folderName. If `timeoutMs`
 * elapses with no match, reject with a clear error including the
 * number of events observed and whether a partial match (row present
 * but not yet quiescent) was ever seen.
 *
 * The returned promise always closes the SQLite handle and stops both
 * watchers, even on timeout / unexpected reject.
 */
export function waitForCompletion(
  opts: WaitForCompletionOptions,
): Promise<WaitForCompletionResult> {
  const timeoutMs = opts.timeoutMs ?? computeDefaultTimeoutMs(opts.durationMs);
  const quiescenceMs = opts.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
  const emptyQuiescenceMs = opts.emptyQuiescenceMs ?? DEFAULT_EMPTY_QUIESCENCE_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const safetyRecheckMs = opts.safetyRecheckMs ?? SAFETY_RECHECK_MS;
  if (!existsSync(opts.swDbPath)) {
    return Promise.reject(new Error(`waitForCompletion: SW DB not found: ${opts.swDbPath}`));
  }
  if (!existsSync(opts.swRecordingsDir)) {
    return Promise.reject(
      new Error(`waitForCompletion: SW recordings dir not found: ${opts.swRecordingsDir}`),
    );
  }
  const dbBasename = basename(opts.swDbPath);
  const dbParentDir = dirname(opts.swDbPath);
  // The query: row exists newer than cutoff, marked as `fromFile`
  // (matches our `open -a` drop-ins), within ±50 ms of expected
  // duration. Two distinct success paths gate on the row contents:
  //
  //   (A) Normal: `length(fts.result) > 0` after the 2 s quiescence
  //       window. SW finished ASR + (optional) LLM cleanup and the
  //       output text is settled.
  //
  //   (B) Empty transcript: `processingTime IS NOT NULL` AND both
  //       `fts.result` and `fts.rawResult` are zero-length, after the
  //       longer 30 s quiescence window. SW finished processing but
  //       the audio was silent (mic muted, VPIO regression, audio
  //       dropout). Returning this as a soft success — with the
  //       `emptyTranscript: true` flag — lets the processor mark
  //       the queue row failed instead of hanging until timeout.
  //
  // The SQL returns enough fields for the caller to distinguish; the
  // branching lives in TS so we don't have to query twice. We DON'T
  // filter on `length(fts.result) > 0` in the WHERE clause anymore —
  // that filter would mask path (B) entirely.
  //
  // Duration filter only applied when the caller supplied a duration;
  // tests can pass null to disable the filter (the gate still requires
  // the other conditions plus mtime quiescence).
  //
  // We wrap both sides of the date comparison in SQLite's `datetime()`
  // function so the cutoff (ISO 8601 with `T` and `Z`, produced by
  // `new Date().toISOString()`) and SW's stored format (space-separated,
  // no timezone — `2026-05-23 03:39:51.131`) get normalized before the
  // string compare. Without this, lexicographic ordering of the raw
  // strings puts every same-day SW row below the cutoff (because space
  // is byte 32 and `T` is byte 84), so the query never matched and
  // `waitForCompletion` hung until timeout — a bug surfaced by Phase 1
  // end-to-end verification on real SW.
  const querySql = `
    SELECT r.folderName            AS folderName,
           length(fts.result)      AS resultLen,
           length(fts.rawResult)   AS rawResultLen,
           r.processingTime        AS processingTime
      FROM recording r
      JOIN recording_fts fts ON fts.recordingId = r.id
     WHERE datetime(r.datetime) > datetime(?)
       AND r.fromFile = 1
       ${opts.durationMs != null ? "AND ABS(r.duration - ?) < 50" : ""}
     ORDER BY r.datetime DESC
     LIMIT 1
  `;

  return new Promise<WaitForCompletionResult>((resolve, reject) => {
    const start = Date.now();
    const db = new Database(opts.swDbPath, { readonly: true });
    let recordingsWatcher: FSWatcher | null = null;
    let dbWatcher: FSWatcher | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let debounceHandle: ReturnType<typeof setTimeout> | null = null;
    let safetyHandle: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const initialMtime = safeMtime(opts.swDbPath);
    const state: InternalState = {
      lastDbMtimeMs: initialMtime,
      lastEventAtMs: initialMtime,
      eventCount: 0,
      partialMatchSeen: false,
    };

    const stmt = opts.durationMs != null ? db.prepare(querySql) : db.prepare(querySql);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (debounceHandle) clearTimeout(debounceHandle);
      if (safetyHandle) clearInterval(safetyHandle);
      try {
        recordingsWatcher?.close();
      } catch {
        // best-effort
      }
      try {
        dbWatcher?.close();
      } catch {
        // best-effort
      }
      try {
        db.close();
      } catch {
        // best-effort
      }
    };

    const checkNow = () => {
      if (settled) return;
      const now = Date.now();
      const sinceMtime = now - state.lastDbMtimeMs;
      // Always fetch the candidate row first — both success paths gate
      // on a row existing. We then branch on `resultLen` / `processingTime`
      // to decide WHICH quiescence window applies (2 s for the normal
      // text-present path, 30 s for the empty-transcript path).
      const raw: unknown =
        opts.durationMs != null
          ? stmt.get(opts.cutoffIso, opts.durationMs)
          : stmt.get(opts.cutoffIso);
      if (raw == null) {
        verbose(`sw-control: no candidate row yet`);
        return;
      }
      const parsed = CandidateRowSchema.safeParse(raw);
      if (!parsed.success) {
        warn(`sw-control: row shape failed validation: ${parsed.error.message}`);
        return;
      }
      state.partialMatchSeen = true;
      const row = parsed.data;

      // Path (A): SW has produced post-LLM text. Standard 2 s quiescence.
      if (row.resultLen > 0) {
        if (sinceMtime < quiescenceMs) {
          verbose(
            `sw-control: text present but not quiescent (mtime ${sinceMtime} ms ago); rechecking`,
          );
          const remaining = quiescenceMs - sinceMtime + 10;
          if (debounceHandle) clearTimeout(debounceHandle);
          debounceHandle = setTimeout(checkNow, remaining);
          return;
        }
        const elapsed = now - start;
        cleanup();
        resolve({
          folderName: row.folderName,
          elapsedMs: elapsed,
          eventCount: state.eventCount,
        });
        return;
      }

      // Path (B): empty result but SW is done processing (processingTime
      // is set). Require the longer 30 s quiescence so we don't race a
      // late LLM rewrite that fills in text.
      if (
        row.processingTime != null &&
        row.resultLen === 0 &&
        row.rawResultLen === 0
      ) {
        if (sinceMtime < emptyQuiescenceMs) {
          verbose(
            `sw-control: empty-transcript candidate, awaiting ${emptyQuiescenceMs} ms quiescence (mtime ${sinceMtime} ms ago)`,
          );
          const remaining = emptyQuiescenceMs - sinceMtime + 10;
          if (debounceHandle) clearTimeout(debounceHandle);
          debounceHandle = setTimeout(checkNow, remaining);
          return;
        }
        const elapsed = now - start;
        verbose(
          `sw-control: resolving with empty transcript for folder=${row.folderName} (silent audio?)`,
        );
        cleanup();
        resolve({
          folderName: row.folderName,
          elapsedMs: elapsed,
          eventCount: state.eventCount,
          emptyTranscript: true,
        });
        return;
      }

      // Row exists but neither path is satisfied yet — SW is still
      // processing. Keep waiting for the next FS event / safety tick.
      verbose(
        `sw-control: candidate row not ready (resultLen=${row.resultLen} processingTime=${row.processingTime})`,
      );
    };

    const onEvent = (source: "recordings" | "db", filename: string | null) => {
      if (settled) return;
      state.eventCount++;
      state.lastEventAtMs = Date.now();
      // For the DB watcher we only care about events on the SW DB file
      // itself (the dir watch can fire for the rollback-journal sidecar
      // too — we treat those as DB activity, which is correct, but only
      // bump mtime if the actual DB file changed).
      if (source === "db") {
        if (filename == null || filename === dbBasename || filename.startsWith(dbBasename)) {
          state.lastDbMtimeMs = Date.now();
        }
      } else {
        // Recordings-dir change: bump mtime tracking too, since the
        // folder appears at the same moment SW writes the row.
        state.lastDbMtimeMs = Date.now();
      }
      if (debounceHandle) clearTimeout(debounceHandle);
      debounceHandle = setTimeout(checkNow, debounceMs);
    };

    try {
      recordingsWatcher = watch(opts.swRecordingsDir, { recursive: true }, (_event, filename) => {
        onEvent("recordings", filename);
      });
      dbWatcher = watch(dbParentDir, { recursive: false }, (_event, filename) => {
        onEvent("db", filename);
      });
    } catch (e) {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      const partial = state.partialMatchSeen ? "partial match seen" : "no partial match";
      cleanup();
      reject(
        new Error(
          `waitForCompletion: timed out after ${timeoutMs} ms (${state.eventCount} events; ${partial})`,
        ),
      );
    }, timeoutMs);

    // Safety net: re-run `checkNow` periodically even with zero events.
    // macOS FSEvents can drop coalesced events under load — without
    // this, a perfectly-timed drop could leave the wait spinning until
    // the hard timeout. The interval is intentionally slow (60 s
    // default) so it adds negligible cost vs the event-driven path.
    safetyHandle = setInterval(() => {
      if (settled) return;
      verbose(`sw-control: safety re-check (${state.eventCount} events so far)`);
      checkNow();
    }, safetyRecheckMs);

    // Trigger one immediate check in case SW has already finished
    // before we attached the watchers. Without this, an extremely
    // short wav could finish processing between `ingestFile` and our
    // watch attaching, and we'd hang until timeout. Still subject to
    // the quiescence gate, so a fast race is harmless.
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(checkNow, debounceMs);
  });
}

/**
 * Default timeout = `max(30 min, 3 × durationMs)`. When `durationMs`
 * is null (caller didn't supply it) we fall back to 30 minutes flat.
 * Exported for unit-test coverage; production callers go through
 * `waitForCompletion(opts)` which calls this internally.
 */
export function computeDefaultTimeoutMs(durationMs: number | null): number {
  if (durationMs == null || durationMs <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(DEFAULT_TIMEOUT_MS, 3 * durationMs);
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}
