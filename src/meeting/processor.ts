/**
 * Meeting-queue processor state machine.
 *
 * Phase 1's headline component: drains the `meeting_queue` FIFO, drives
 * Super Whisper one item at a time, patches the resulting SW row's
 * `datetime`, and targeted-ingests it into the archive.
 *
 * State machine:
 *
 *   paused      ←─── (default; no item is being worked on)
 *      │
 *      │ start()
 *      ▼
 *   processing  ←─── (the worker loop is running)
 *      │
 *      │ pause() with item in flight
 *      ▼
 *   pausing     (loop finishes the current item, then transitions to paused)
 *      │
 *      ▼
 *   paused
 *
 * The state is persisted in the `config` table at key
 * `meeting_queue_state`. Concurrent processes that open the archive
 * read the same value, so a future Phase 4 daemon and a foreground
 * `swrag meeting queue start` invocation cannot both think they own
 * the loop simultaneously — only the one that successfully transitions
 * `paused → processing` proceeds. This is currently advisory (we don't
 * use locks); two CLI processes both calling `start()` is a user error
 * Phase 4's socket-server will prevent structurally.
 *
 * The worker loop body (per item):
 *   1. mark transcribing
 *   2. capture cutoffIso = now()
 *   3. ingestFile (open -a superwhisper)
 *   4. await waitForCompletion → folderName
 *   5. patcher.patch(folderName, captured_at)
 *   6. runIndexFolder({ folderName, ... })
 *   7. mark completed (or failed on any error)
 *   8. unlink the wav unless SWRAG_KEEP_QUEUE_AUDIO=1
 *   9. if state === pausing → set paused and break
 *
 * On constructor: scan for rows stuck in `transcribing` (crash mid-item).
 * For each, cross-check SW; if SW has the row with non-empty result,
 * run the rest of the loop. Else mark failed.
 */
import { Database } from "bun:sqlite";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import { getConfig, openArchive, setConfig } from "../archive/open.ts";
import { runIndexFolder } from "../commands/index.ts";
import { info, verbose, warn } from "../log.ts";
import { SwPatcher } from "./patcher.ts";
import * as queue from "./queue.ts";
import { ingestFile, waitForCompletion } from "./sw-control.ts";

export const MeetingQueueStateSchema = z.enum(["paused", "processing", "pausing"]);
export type MeetingQueueState = z.infer<typeof MeetingQueueStateSchema>;

export const MEETING_QUEUE_STATE_KEY = "meeting_queue_state";
const BASE_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Effective completion timeout for a single item. The base floor is
 * 30 minutes; for long recordings we scale to `3 × durationMs` so a
 * 90-minute meeting doesn't time out at 30 min wall-clock.
 */
function effectiveCompletionTimeout(
  durationMs: number | null,
  override: number | undefined,
): number {
  if (override != null) return override;
  if (durationMs == null || durationMs <= 0) return BASE_COMPLETION_TIMEOUT_MS;
  return Math.max(BASE_COMPLETION_TIMEOUT_MS, 3 * durationMs);
}

/**
 * `transcribing` rows the processor finds at construction time get
 * this sentinel error if their SW counterpart cannot be cross-checked.
 */
export const LOST_IN_TRANSIT_ERROR = "lost in transit; daemon restarted";

const SwFolderProbeSchema = z.object({
  folderName: z.string(),
  result: z.string().nullable(),
});

export interface ProcessorOptions {
  archive: string;
  sourceDir: string;
  sourceDb: string;
  swDbPath: string;
  swRecordingsDir: string;
  embedModel: string;
  ollamaHost: string;
  /**
   * Set to true to keep the wav on disk after a successful completion.
   * The default (false) unlinks it; size budget for `meetings/incoming/`
   * stays bounded.
   */
  keepAudio?: boolean;
  /** Override the default `waitForCompletion` timeout (30 min). */
  completionTimeoutMs?: number;
  /**
   * Phase 4 integration glue. Invoked whenever the state machine
   * transitions (paused → processing → pausing → paused) or whenever
   * the current item / batch position changes. The Phase 4 daemon
   * uses this to push `queue_state_changed` events to subscribed
   * sockets — no polling required. Optional; foreground CLI callers
   * (Phase 1) leave it `undefined` and pay no cost.
   */
  onStateChange?: (snap: StateSnapshot) => void;
  /**
   * Phase 4 integration glue. Invoked whenever a queue row's status
   * changes (transcribing → failed) or the row is deleted entirely
   * (completed-and-deleted, or user-discarded). The daemon uses this
   * to push `queue_changed` events to subscribed sockets. Optional;
   * CLI callers without the daemon leave it `undefined`.
   *
   * The `"deleted"` sentinel is not a SQL `status` value — it's the
   * notification that a row vanished from the table. The daemon's
   * fan-out treats it the same as a status change: emit
   * `queue_changed` with reason `item:deleted` so subscribers
   * re-fetch.
   */
  onItemChanged?: (id: number, status: queue.MeetingQueueStatus | "deleted") => void;
  /**
   * Test hooks. Production code leaves all of these `undefined`.
   */
  hooks?: ProcessorHooks;
}

export interface ProcessorHooks {
  /** Replace the SW ingest call (default: real `open -a superwhisper`). */
  ingestFile?: (path: string) => Promise<void>;
  /** Replace the FSEvents-driven wait (default: real `waitForCompletion`). */
  waitForCompletion?: (params: {
    cutoffIso: string;
    durationMs: number | null;
    timeoutMs: number;
  }) => Promise<{ folderName: string; emptyTranscript?: boolean }>;
  /** Replace SwPatcher with a stub. */
  makePatcher?: () => { patch: SwPatcher["patch"]; close: SwPatcher["close"] };
  /** Replace `runIndexFolder` (default: real targeted ingest). */
  runIndexFolder?: typeof runIndexFolder;
}

/**
 * Sentinel error stored on the queue row when SW reports the audio
 * went all the way through its pipeline but produced no text. Tracked
 * as a constant so callers (UI, tests) can match on it.
 */
export const EMPTY_TRANSCRIPT_ERROR = "SW returned empty transcript (silent audio?)";

export interface StateSnapshot {
  state: MeetingQueueState;
  current_item: queue.MeetingQueueRow | null;
  batch_position: number | null;
  batch_size: number | null;
}

export interface DiscardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Read the persisted state (default `paused`).
 */
export function readState(archive: string): MeetingQueueState {
  const db = openArchive(archive, {});
  try {
    return readStateOn(db);
  } finally {
    db.close();
  }
}

function readStateOn(db: Database): MeetingQueueState {
  const raw = getConfig(db, MEETING_QUEUE_STATE_KEY);
  if (raw == null) return "paused";
  const parsed = MeetingQueueStateSchema.safeParse(raw);
  if (!parsed.success) {
    warn(`invalid meeting_queue_state value ${JSON.stringify(raw)}; treating as paused`);
    return "paused";
  }
  return parsed.data;
}

function writeStateOn(db: Database, state: MeetingQueueState): void {
  setConfig(db, MEETING_QUEUE_STATE_KEY, state);
}

/**
 * Processor instances are cheap and stateless besides the in-memory
 * `current_item` / `batch_size`. Tests spawn one per case. Production
 * code (Phase 4) will spawn one inside the daemon and pump it via the
 * socket server.
 */
export class MeetingProcessor {
  private currentItem: queue.MeetingQueueRow | null = null;
  private batchSize: number | null = null;
  private batchPosition: number | null = null;
  /** Set when start() resolves to the running loop's promise. */
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly opts: ProcessorOptions) {}

  /**
   * Initialise the processor: scan for `transcribing` rows left behind
   * by a previous crash and either complete or fail them. Idempotent.
   * Call once per process — the worker loop assumes it's been run.
   */
  async recoverTranscribingRows(): Promise<void> {
    const db = openArchive(this.opts.archive, {});
    let stuck: queue.MeetingQueueRow[];
    try {
      stuck = queue.listTranscribing(db);
    } finally {
      db.close();
    }
    if (stuck.length === 0) return;
    verbose(`processor: recovering ${stuck.length} transcribing row(s)`);
    for (const row of stuck) {
      await this.recoverOne(row);
    }
  }

  /**
   * Public state snapshot — readable from any callsite, including
   * a separate process via `readState` + `queue.countPending`.
   */
  state(): StateSnapshot {
    const archiveState = readState(this.opts.archive);
    return {
      state: archiveState,
      current_item: this.currentItem,
      batch_position: this.batchPosition,
      batch_size: this.batchSize,
    };
  }

  /**
   * Transition `paused → processing`, kick the loop. Idempotent: if
   * already processing, no-op and returns the existing loop promise.
   */
  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    const db = openArchive(this.opts.archive, {});
    try {
      // Note: a persisted `processing` value with no live loop here
      // (loopPromise === null) means the previous owner crashed before
      // transitioning back to `paused`. The plan calls for resuming
      // the loop in that case — DON'T early-return, fall through and
      // kick the loop again.
      this.batchSize = queue.countPending(db);
      this.batchPosition = 0;
      writeStateOn(db, "processing");
    } finally {
      db.close();
    }
    info(`meeting queue: starting (batch_size=${this.batchSize ?? 0})`);
    this.notifyStateChange();
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
    });
    return this.loopPromise;
  }

  /**
   * Transition `processing → pausing` (or straight to `paused` if no
   * item is in flight). Idempotent. Resolves once the state lands at
   * `paused` — for callers that want `start && await pause`.
   */
  async pause(): Promise<void> {
    const db = openArchive(this.opts.archive, {});
    try {
      const current = readStateOn(db);
      if (current === "paused") return;
      if (current === "pausing") {
        // Already pausing; fall through to wait for paused.
      } else if (this.currentItem == null) {
        // Processing but no item in flight (between items, or the loop
        // hasn't picked up yet). Go straight to paused.
        writeStateOn(db, "paused");
        this.notifyStateChange();
        return;
      } else {
        writeStateOn(db, "pausing");
        this.notifyStateChange();
      }
    } finally {
      db.close();
    }
    // Wait for the loop to transition through.
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }

  /**
   * Discard a queued row. Refuses if the row is currently in flight
   * (i.e. `currentItem.id === id`).
   *
   * v0.9.1: the row is DELETED from the queue table (not marked
   * `failed` with a sentinel error). The archive's `recording` table
   * stays untouched — discard is for queue-state-only cleanup, never
   * for already-completed items that have a transcript. The
   * `row.status === 'completed'` check is now defence-in-depth: under
   * the new policy completed rows shouldn't exist in the queue at
   * all, but we still refuse just in case a legacy row survives the
   * upgrade.
   *
   * The on-disk wav is also removed (best-effort) so
   * `meetings/incoming/` stays bounded.
   */
  discard(id: number): DiscardResult {
    if (this.currentItem?.id === id) {
      return { ok: false, reason: "row is currently being processed" };
    }
    const db = openArchive(this.opts.archive, {});
    try {
      const row = queue.getById(db, id);
      if (!row) {
        return { ok: false, reason: `no queue row with id ${id}` };
      }
      if (row.status === "completed") {
        return { ok: false, reason: `row ${id} is already completed` };
      }
      const removed = queue.removeRow(db, id);
      if (!removed) {
        return { ok: false, reason: `row ${id} vanished before delete` };
      }
      if (row.audio_path && existsSync(row.audio_path)) {
        try {
          // sync unlink to keep `discard` non-async (it's a one-shot CLI op)
          // — fall back silently if filesystem balks.
          Bun.spawnSync(["rm", "-f", row.audio_path]);
        } catch {
          // best-effort
        }
      }
      // Notify the daemon observer so the menubar can refresh. We
      // reuse the existing `onItemChanged` callback with a sentinel
      // "deleted" status — the daemon translates this to a
      // `queue_changed` push and the menubar re-fetches `queue_list`.
      this.notifyItemChanged(id, "deleted");
      return { ok: true };
    } finally {
      db.close();
    }
  }

  /** -------------------- internal: the worker loop -------------------- */

  private async loop(): Promise<void> {
    while (true) {
      // Read state at top of each iteration so external `pause()` can
      // interrupt us between items.
      const stateNow = readState(this.opts.archive);
      if (stateNow !== "processing") {
        // External pause already finalised; or we're at the natural
        // end of the queue (set by the no-row branch below).
        return;
      }

      const row = this.nextPending();
      if (!row) {
        this.finaliseState("paused", "queue drained");
        return;
      }
      this.currentItem = row;
      this.notifyStateChange();
      try {
        await this.processOne(row);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn(`meeting queue: item ${row.id} failed: ${msg}`);
        this.markFailedSafe(row.id, msg);
      } finally {
        this.currentItem = null;
        if (this.batchPosition != null) this.batchPosition += 1;
        this.notifyStateChange();
      }
      // If pause() was requested during processOne, transition now.
      const afterState = readState(this.opts.archive);
      if (afterState === "pausing") {
        this.finaliseState("paused", "pause requested");
        return;
      }
    }
  }

  private async processOne(row: queue.MeetingQueueRow): Promise<void> {
    this.markTranscribingSafe(row.id);
    const cutoffIso = new Date().toISOString();
    const ingest = this.opts.hooks?.ingestFile ?? defaultIngestFile;
    await ingest(row.audio_path);

    const wait =
      this.opts.hooks?.waitForCompletion ??
      ((params) =>
        waitForCompletion({
          swDbPath: this.opts.swDbPath,
          swRecordingsDir: this.opts.swRecordingsDir,
          cutoffIso: params.cutoffIso,
          durationMs: params.durationMs,
          timeoutMs: params.timeoutMs,
        }));
    const completion = await wait({
      cutoffIso,
      durationMs: row.duration_ms,
      timeoutMs: effectiveCompletionTimeout(row.duration_ms, this.opts.completionTimeoutMs),
    });
    const folderName = completion.folderName;

    // SW reported processing-finished with empty result — silent audio.
    // We must NOT proceed to patch + index (there's no transcript to
    // archive, and patching an empty row would just pollute SW's DB
    // with a backdated stub). Mark the queue row failed with a clear
    // sentinel error and unlink the wav so `meetings/incoming/` doesn't
    // accumulate. This is the safety net for the VPIO-zero-buffer bug
    // (v0.9.3): even if the recorder regresses to silence, the queue
    // won't hang forever on a row that will never grow text.
    if (completion.emptyTranscript) {
      warn(
        `meeting queue: item ${row.id} → SW empty transcript (folder=${folderName})`,
      );
      this.markFailedSafe(row.id, EMPTY_TRANSCRIPT_ERROR);
      if (!this.opts.keepAudio && existsSync(row.audio_path)) {
        try {
          await unlink(row.audio_path);
        } catch (e) {
          verbose(
            `meeting queue: failed to unlink ${row.audio_path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return;
    }

    const patcher = this.opts.hooks?.makePatcher
      ? this.opts.hooks.makePatcher()
      : new SwPatcher({
          swDbPath: this.opts.swDbPath,
          swRecordingsDir: this.opts.swRecordingsDir,
        });
    try {
      await patcher.patch(folderName, row.captured_at);
    } finally {
      patcher.close();
    }

    const index = this.opts.hooks?.runIndexFolder ?? runIndexFolder;
    await index({
      folderName,
      sourceDir: this.opts.sourceDir,
      sourceDb: this.opts.swDbPath,
      archive: this.opts.archive,
      embedModel: this.opts.embedModel,
      ollamaHost: this.opts.ollamaHost,
    });

    this.markCompletedSafe(row.id, folderName);
    if (!this.opts.keepAudio && existsSync(row.audio_path)) {
      try {
        await unlink(row.audio_path);
      } catch (e) {
        verbose(
          `meeting queue: failed to unlink ${row.audio_path}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    info(`meeting queue: item ${row.id} done → ${folderName}`);
  }

  private async recoverOne(row: queue.MeetingQueueRow): Promise<void> {
    // Cross-check SW: if it has the matching folderName with non-empty
    // result, finish the loop for it. Else mark failed.
    const swFolder = await this.findStuckSwFolder(row);
    if (!swFolder) {
      warn(`meeting queue: recovering id=${row.id} → ${LOST_IN_TRANSIT_ERROR}`);
      this.markFailedSafe(row.id, LOST_IN_TRANSIT_ERROR);
      return;
    }
    try {
      const patcher = this.opts.hooks?.makePatcher
        ? this.opts.hooks.makePatcher()
        : new SwPatcher({
            swDbPath: this.opts.swDbPath,
            swRecordingsDir: this.opts.swRecordingsDir,
          });
      try {
        await patcher.patch(swFolder, row.captured_at);
      } finally {
        patcher.close();
      }
      const index = this.opts.hooks?.runIndexFolder ?? runIndexFolder;
      await index({
        folderName: swFolder,
        sourceDir: this.opts.sourceDir,
        sourceDb: this.opts.swDbPath,
        archive: this.opts.archive,
        embedModel: this.opts.embedModel,
        ollamaHost: this.opts.ollamaHost,
      });
      this.markCompletedSafe(row.id, swFolder);
      // The recovery path is functionally equivalent to processOne
      // minus the ingest + wait — same cleanup obligations. If the
      // wav still lives on disk and the user hasn't opted into
      // SWRAG_KEEP_QUEUE_AUDIO, delete it so `meetings/incoming/`
      // stays bounded across crashes.
      if (!this.opts.keepAudio && row.audio_path && existsSync(row.audio_path)) {
        try {
          await unlink(row.audio_path);
        } catch (e) {
          verbose(
            `meeting queue: failed to unlink ${row.audio_path} during recovery: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      info(`meeting queue: recovered id=${row.id} → ${swFolder}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`meeting queue: recovery for id=${row.id} failed: ${msg}`);
      this.markFailedSafe(row.id, msg);
    }
  }

  /**
   * Find a SW row that plausibly corresponds to a stuck `transcribing`
   * queue row. We re-use the duration heuristic from `waitForCompletion`
   * (±50 ms) but loosen the time constraint — the wav was enqueued
   * possibly a long time ago, so we ignore `cutoffIso` and rely on
   * (duration, fromFile, non-empty result, sw_folder_name if recorded).
   */
  private async findStuckSwFolder(row: queue.MeetingQueueRow): Promise<string | null> {
    if (row.sw_folder_name) {
      // Easy case: the previous run got far enough to record the folder.
      // Verify SW still has it with non-empty result.
      const db = new Database(this.opts.swDbPath, { readonly: true });
      try {
        const raw: unknown = db
          .prepare(
            `SELECT r.folderName AS folderName, fts.result AS result
               FROM recording r
          LEFT JOIN recording_fts fts ON fts.recordingId = r.id
              WHERE r.folderName = ?`,
          )
          .get(row.sw_folder_name);
        if (raw == null) return null;
        const parsed = SwFolderProbeSchema.safeParse(raw);
        if (!parsed.success) return null;
        if (!parsed.data.result || parsed.data.result.length === 0) return null;
        return parsed.data.folderName;
      } finally {
        db.close();
      }
    }
    if (row.duration_ms == null) return null;
    const db = new Database(this.opts.swDbPath, { readonly: true });
    try {
      const raw: unknown = db
        .prepare(
          `SELECT r.folderName AS folderName, fts.result AS result
             FROM recording r
             JOIN recording_fts fts ON fts.recordingId = r.id
            WHERE r.fromFile = 1
              AND length(fts.result) > 0
              AND ABS(r.duration - ?) < 50
         ORDER BY r.datetime DESC
            LIMIT 1`,
        )
        .get(row.duration_ms);
      if (raw == null) return null;
      const parsed = SwFolderProbeSchema.safeParse(raw);
      if (!parsed.success) return null;
      return parsed.data.folderName;
    } finally {
      db.close();
    }
  }

  /** -------------------- DB helpers (open + close per op) -------------------- */

  private nextPending(): queue.MeetingQueueRow | null {
    const db = openArchive(this.opts.archive, {});
    try {
      return queue.nextPending(db);
    } finally {
      db.close();
    }
  }

  private markTranscribingSafe(id: number): void {
    const db = openArchive(this.opts.archive, {});
    try {
      queue.markTranscribing(db, id);
    } finally {
      db.close();
    }
    this.notifyItemChanged(id, "transcribing");
  }

  /**
   * v0.9.1 policy: a successfully processed item is DELETED from the
   * queue table rather than parked as `status='completed'`. The
   * archive's `recording` table already holds the canonical
   * transcript after `runIndexFolder` returns, so the queue row is
   * just operational state at this point.
   *
   * We still fire the `onItemChanged` callback with `"completed"`
   * (not `"deleted"`) so the daemon's `queue_changed` push carries
   * a reason the menubar already recognises — subscribers refetch
   * `queue_list` and see the row is gone. The `folderName` argument
   * is retained for log / future-extension purposes; it's not stored
   * (the row no longer exists).
   */
  private markCompletedSafe(id: number, folderName: string): void {
    const db = openArchive(this.opts.archive, {});
    try {
      queue.removeRow(db, id);
    } finally {
      db.close();
    }
    verbose(`meeting queue: deleted completed row id=${id} (sw_folder=${folderName})`);
    this.notifyItemChanged(id, "completed");
  }

  private markFailedSafe(id: number, msg: string): void {
    const db = openArchive(this.opts.archive, {});
    try {
      queue.markFailed(db, id, msg);
    } finally {
      db.close();
    }
    this.notifyItemChanged(id, "failed");
  }

  private finaliseState(state: MeetingQueueState, reason: string): void {
    const db = openArchive(this.opts.archive, {});
    try {
      writeStateOn(db, state);
    } finally {
      db.close();
    }
    info(`meeting queue: state=${state} (${reason})`);
    this.notifyStateChange();
  }

  /**
   * Best-effort fan-out to the daemon observer. Errors in the
   * callback are swallowed — a misbehaving observer must NEVER take
   * down the queue loop.
   */
  private notifyStateChange(): void {
    const cb = this.opts.onStateChange;
    if (!cb) return;
    try {
      cb(this.state());
    } catch (e) {
      verbose(
        `meeting queue: onStateChange callback threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private notifyItemChanged(id: number, status: queue.MeetingQueueStatus | "deleted"): void {
    const cb = this.opts.onItemChanged;
    if (!cb) return;
    try {
      cb(id, status);
    } catch (e) {
      verbose(
        `meeting queue: onItemChanged callback threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

async function defaultIngestFile(path: string): Promise<void> {
  await ingestFile(path);
}
