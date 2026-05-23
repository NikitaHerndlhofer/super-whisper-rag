/**
 * Phase 3 recorder lifecycle.
 *
 * `startRecording` spawns `swrag-helper record` and waits for the first
 * heartbeat before returning — proving the helper has actually started
 * laying down audio (not just that `spawn()` succeeded). The wav path
 * follows the existing meetings path convention:
 *
 *   ~/Library/Application Support/superwhisper-rag/meetings/incoming/
 *     <unix-ts>-<short-uuid>.wav
 *
 * `stopRecording` SIGTERMs the helper, waits for clean exit, then either:
 *   - On save: reads the WAV's duration (via the AVAudioFile-readable
 *     header — we shell to `afinfo` for symmetry with `swrag enqueue`)
 *     and enqueues a `pending` row in `meeting_queue`.
 *   - On discard: returns nulls; the spawnRecorder's `stop({ discard })`
 *     already unlinked the wav.
 *
 * All inputs / outputs that cross a process boundary are zod-validated.
 * The CLI layer is responsible for the legal consent ack — by the time
 * we get here, system-audio capture is allowed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openArchive } from "../archive/open.ts";
import { verbose, warn } from "../log.ts";
import {
  type RecorderHandle,
  type RecorderHeartbeat,
  spawnRecorder,
} from "../mac/helper.ts";
import * as queue from "./queue.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export const DEFAULT_MEETINGS_INCOMING_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "superwhisper-rag",
  "meetings",
  "incoming",
);

export interface StartRecordingOptions {
  label?: string;
  captureSystemAudio?: boolean;
}

export interface RecordingHandle {
  audioPath: string;
  /** ISO8601 timestamp captured at the moment the recorder confirmed start. */
  startedAt: string;
  label: string | null;
  captureSystemAudio: boolean;
  // Internal — exposed so tests can drive heartbeats / inspect the
  // subprocess. The CLI doesn't touch this directly; `stopRecording`
  // is the one path callers should use.
  recorder: RecorderHandle;
}

export interface StoppedRecording {
  /** The queue row, or null when the recording was discarded. */
  queueRow: queue.MeetingQueueRow | null;
  durationMs: number;
  /** Path to the wav (still on disk), or null on discard. */
  audioPath: string | null;
  /** Exit code of the recorder subprocess. */
  exitCode: number;
  /** Trimmed stderr tail (~8 KB) of the recorder subprocess. */
  stderr: string;
}

/* -------------------------------------------------------------------------- */
/* Dependencies — exposed so tests can inject stubs.                          */
/* -------------------------------------------------------------------------- */

/**
 * Side-effects we want to override in tests: the recorder spawn itself,
 * the on-disk path generator, the wall clock, and the `afinfo`-driven
 * duration probe. Everything has a sensible default.
 */
export interface RecordDeps {
  archive: string;
  /**
   * Where new wavs land. Defaults to
   * `~/Library/Application Support/superwhisper-rag/meetings/incoming/`.
   * Tests point this at a temp dir.
   */
  incomingDir?: string;
  spawnRecorder?: typeof spawnRecorder;
  now?: () => Date;
  /** Optional UUID-ish suffix factory; defaults to randomShortId(). */
  randomId?: () => string;
  /**
   * Resolves the duration of the wav at `path` in ms after the recorder
   * exits. Defaults to `afinfoDurationMs`. Returning null surfaces as a
   * null duration on the queue row.
   */
  durationProbe?: (path: string) => Promise<number | null>;
}

/* -------------------------------------------------------------------------- */
/* startRecording                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Window we'll wait for the very first heartbeat from the Swift helper.
 * The helper's heartbeat timer fires 1 s after start; we add a generous
 * safety margin so a slow VPIO init or SCStream warm-up doesn't trip a
 * false start failure.
 */
const FIRST_HEARTBEAT_TIMEOUT_MS = 5_000;

export async function startRecording(
  opts: StartRecordingOptions,
  deps: RecordDeps,
): Promise<RecordingHandle> {
  const incoming = deps.incomingDir ?? DEFAULT_MEETINGS_INCOMING_DIR;
  mkdirSync(incoming, { recursive: true });

  const now = deps.now ?? (() => new Date());
  const randomId = deps.randomId ?? randomShortId;
  const startTime = now();
  const audioPath = buildAudioPath(incoming, startTime, randomId());

  const spawn = deps.spawnRecorder ?? spawnRecorder;
  const recorder = spawn({
    outputPath: audioPath,
    captureSystemAudio: opts.captureSystemAudio === true,
  });

  // Wait for the first heartbeat to confirm the recorder is actually
  // capturing. The recorder exposes a dedicated firstHeartbeat()
  // promise wired up synchronously at spawn time — we use that
  // instead of iterating events to avoid a race where the drain
  // emits before any iterator subscribes. If the helper exits before
  // a heartbeat (mic permission denied, screen recording permission
  // denied, format mismatch, …) the promise rejects and we surface
  // the helper's stderr tail to the caller.
  await raceFirstHeartbeat(recorder, FIRST_HEARTBEAT_TIMEOUT_MS).catch(
    async (err: unknown) => {
      const stopResult = await recorder.stop({ discard: true });
      const tail = stopResult.stderr || recorder.stderrTail();
      const baseMsg = err instanceof Error ? err.message : String(err);
      const suffix = tail ? `: ${tail}` : "";
      throw new Error(`recorder failed to start${suffix} (${baseMsg})`);
    },
  );

  return {
    audioPath,
    startedAt: startTime.toISOString(),
    label: opts.label ?? null,
    captureSystemAudio: opts.captureSystemAudio === true,
    recorder,
  };
}

/* -------------------------------------------------------------------------- */
/* stopRecording                                                              */
/* -------------------------------------------------------------------------- */

export async function stopRecording(
  handle: RecordingHandle,
  opts: { discard: boolean },
  deps: RecordDeps,
): Promise<StoppedRecording> {
  const now = deps.now ?? (() => new Date());
  const stopResult = await handle.recorder.stop({ discard: opts.discard });

  if (opts.discard) {
    // spawnRecorder.stop already unlinked the wav.
    return {
      queueRow: null,
      durationMs: 0,
      audioPath: null,
      exitCode: stopResult.exitCode,
      stderr: stopResult.stderr,
    };
  }

  if (stopResult.exitCode !== 0) {
    // Non-zero exit on save path means the WAV is suspect. Don't
    // enqueue a row for it — the wav stays on disk for forensics
    // (the user can `swrag enqueue` it manually if they trust it).
    const tail = stopResult.stderr || "no stderr";
    throw new Error(
      `recorder exited non-zero (${stopResult.exitCode}); wav at ${handle.audioPath} not enqueued: ${tail}`,
    );
  }

  if (!existsSync(handle.audioPath)) {
    throw new Error(
      `recorder exited cleanly but the wav does not exist at ${handle.audioPath}`,
    );
  }

  const probe = deps.durationProbe ?? afinfoDurationMs;
  const durationMs = await probe(handle.audioPath);
  const capturedUntil = now().toISOString();

  const db = openArchive(deps.archive, {});
  let row: queue.MeetingQueueRow;
  try {
    row = queue.enqueue(db, {
      audio_path: handle.audioPath,
      captured_at: handle.startedAt,
      captured_until: capturedUntil,
      duration_ms: durationMs,
      label: handle.label,
    });
  } finally {
    db.close();
  }
  return {
    queueRow: row,
    durationMs: durationMs ?? 0,
    audioPath: handle.audioPath,
    exitCode: stopResult.exitCode,
    stderr: stopResult.stderr,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Race `recorder.firstHeartbeat()` against a timeout. Resolves with
 * the first heartbeat, rejects on timeout / early-exit.
 */
function raceFirstHeartbeat(
  recorder: RecorderHandle,
  timeoutMs: number,
): Promise<RecorderHeartbeat> {
  return new Promise<RecorderHeartbeat>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`no heartbeat within ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    recorder.firstHeartbeat().then(
      (hb) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(hb);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** `<unix-ts>-<short-uuid>.wav` under `<incoming>/`. */
export function buildAudioPath(incomingDir: string, when: Date, id: string): string {
  const ts = Math.floor(when.getTime() / 1000);
  return join(incomingDir, `${ts}-${id}.wav`);
}

/** 8-character base36 id, ~41 bits of entropy. Collision-resistant enough
 *  for human-scale recording rates. We avoid `crypto.randomUUID()`'s
 *  hyphens in filenames just for tidiness. */
export function randomShortId(): string {
  // We deliberately keep the entropy bounded to 8 chars so test fixtures
  // can match against a stable regex. `crypto.getRandomValues` keeps the
  // entropy uniform across runs.
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) {
    out += (b % 36).toString(36);
  }
  return out;
}

/**
 * Duration probe via `afinfo`. Same logic as `src/cli.ts::durationMsForWav`
 * but local — we re-implement to avoid pulling the CLI into the recorder
 * module's dependency graph.
 */
const AfinfoLineSchema = z.string();

export async function afinfoDurationMs(path: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["afinfo", path], { stdout: "pipe", stderr: "pipe" });
    const out = await Bun.readableStreamToText(proc.stdout);
    const exit = await proc.exited;
    if (exit !== 0) {
      verbose(`afinfo exited ${exit} for ${path}`);
      return null;
    }
    const text = AfinfoLineSchema.parse(out);
    const m = text.match(/estimated duration:\s*([0-9.]+)\s*sec/i);
    const captured = m?.[1];
    if (!captured) return null;
    const seconds = Number.parseFloat(captured);
    if (!Number.isFinite(seconds)) return null;
    return Math.round(seconds * 1000);
  } catch (e) {
    warn(`afinfo failed for ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
