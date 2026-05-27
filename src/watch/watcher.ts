/**
 * Long-running FSEvents-based daemon that keeps the archive in sync with
 * Super Whisper without polling.
 *
 * Architecture:
 *
 *   1. Startup catch-up:        runIndex() once, immediately. Picks up
 *                               anything that landed while the daemon
 *                               was down. Failure here is logged but
 *                               does NOT exit — the daemon stays up so
 *                               a transient ollama outage at boot
 *                               doesn't tear down the watcher.
 *   2. Two fs.watch subscribers:
 *        a) recursive on `sourceDir`  — fires when Super Whisper writes
 *           audio / meta.json into a new recording folder.
 *        b) non-recursive on `dirname(sourceDb)` — fires when Super
 *           Whisper commits a row to its SQLite. Path-filtered to the
 *           DB filename so neighbouring file changes don't trigger us.
 *   3. Coalescing debounce (2s): any event resets a 2s timer; only when
 *      the timer fires do we kick off `runIndex`. Super Whisper's
 *      finish-recording sequence emits ~5–10 events in quick
 *      succession; a single ingest at the tail handles them all.
 *   4. Single-flight: while an ingest is in-flight, additional events
 *      are coalesced into a "rerun queued" flag so we ingest exactly
 *      once more after the current run completes. Prevents the
 *      pathological case where a long initial backfill is interrupted
 *      mid-run by its own writes triggering another ingest.
 *   5. SIGTERM/SIGINT clean shutdown: stop both watchers, cancel any
 *      pending debounce timer, await the in-flight ingest if any, exit
 *      0. launchd's default `SIGTERM → SIGKILL after 20s` window is
 *      plenty for the worst case (a multi-minute Ollama re-embed of a
 *      changed model is unusual at shutdown time, and even then we
 *      degrade to SIGKILL which the next launchd boot recovers from).
 *
 * Why not per-folder ingest? The pre-v1.0 meeting pipeline patched
 * Super Whisper's datetime out of order, so a single bulk ingest could
 * miss rows that landed with a backdated timestamp. With that pipeline
 * gone, Super Whisper's row datetimes monotonically increase by
 * construction, and the bulk path (with the `datetime()`-normalised
 * WHERE clause from sources.ts) catches every new row reliably.
 */
import { existsSync } from "node:fs";
import { watch } from "node:fs/promises";
import { dirname } from "node:path";
import { runIndex } from "../commands/index.ts";
import { info, verbose, warn } from "../log.ts";

export interface WatchOptions {
  archive: string;
  sourceDir: string;
  sourceDb: string;
  embedModel: string;
  ollamaHost: string;
  skipEmbeddings: boolean;
  /** Override the debounce window. Tests use a short value. */
  debounceMs?: number;
  /** Override the ingest function (tests inject a counter). */
  runIngest?: (opts: WatchOptions) => Promise<void>;
  /**
   * When set, an external AbortController controls daemon lifetime.
   * Tests provide this so the runWatch promise resolves cleanly
   * without sending real signals. Production code path leaves this
   * unset and the daemon relies on SIGTERM/SIGINT instead.
   */
  abortSignal?: AbortSignal;
  /**
   * Hook fired after each completed ingest (success or failure). Tests
   * use this to await ingest cycles deterministically without polling.
   */
  onIngestComplete?: () => void;
}

const DEFAULT_DEBOUNCE_MS = 2_000;

/**
 * Top-level entry. Blocks until the process receives SIGTERM/SIGINT
 * (or `abortSignal` aborts), then resolves.
 */
export async function runWatch(opts: WatchOptions): Promise<void> {
  if (!existsSync(opts.sourceDir)) {
    throw new Error(
      `source dir does not exist: ${opts.sourceDir}. ` +
        "Is Super Whisper installed? Expected the default " +
        "`~/Documents/superwhisper` layout, override via SWRAG_SOURCE_DIR.",
    );
  }
  const sourceDbDir = dirname(opts.sourceDb);
  if (!existsSync(sourceDbDir)) {
    throw new Error(
      `source DB parent dir does not exist: ${sourceDbDir}. ` +
        "Override via SWRAG_SOURCE_DB if Super Whisper lives in a non-default location.",
    );
  }

  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ingest = opts.runIngest ?? defaultRunIngest;

  info(
    `watch: starting (sourceDir=${opts.sourceDir}, sourceDb=${opts.sourceDb}, debounce=${debounceMs}ms)`,
  );

  // Internal controller chains the user-supplied signal (tests) with
  // our own signal-handler aborts (production). We always abort our
  // own to tear down fs.watch loops, even when the user supplied one.
  const controller = new AbortController();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      controller.abort();
    } else {
      opts.abortSignal.addEventListener(
        "abort",
        () => {
          controller.abort();
        },
        { once: true },
      );
    }
  }

  // Single-flight + coalescing state.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let ingestInFlight: Promise<void> | null = null;
  let rerunQueued = false;

  function scheduleIngest(reason: string): void {
    verbose(`watch: fs event (${reason})`);
    if (ingestInFlight) {
      rerunQueued = true;
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void kickIngest();
    }, debounceMs);
  }

  async function kickIngest(): Promise<void> {
    if (ingestInFlight) {
      rerunQueued = true;
      return;
    }
    ingestInFlight = runOneIngestCycle(opts, ingest);
    try {
      await ingestInFlight;
    } finally {
      ingestInFlight = null;
      opts.onIngestComplete?.();
      if (rerunQueued) {
        rerunQueued = false;
        // Re-queue through the debounce path so a burst of "queued
        // during ingest" events still coalesces.
        scheduleIngest("rerun-queued");
      }
    }
  }

  // Startup catch-up. We schedule it through `kickIngest` (not
  // `scheduleIngest`) so it runs immediately rather than waiting out
  // the debounce — at boot we want to surface progress to launchd /
  // logs as soon as possible.
  void kickIngest();

  // Wire SIGTERM/SIGINT only when no abortSignal was provided. Tests
  // drive shutdown through the abortSignal path so they don't have to
  // install / clean up signal handlers in a shared process.
  const installSignalHandlers = opts.abortSignal == null;
  const onSignal = (sig: NodeJS.Signals): void => {
    info(`watch: ${sig} received, shutting down`);
    controller.abort();
  };
  if (installSignalHandlers) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  try {
    const recordingsWatcher = watchRecordings(opts.sourceDir, controller.signal, scheduleIngest);
    const dbWatcher = watchSourceDb(
      sourceDbDir,
      opts.sourceDb,
      controller.signal,
      scheduleIngest,
    );

    // Wait for both watch loops to exit (only happens on abort).
    await Promise.allSettled([recordingsWatcher, dbWatcher]);
  } finally {
    if (installSignalHandlers) {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    // Await any in-flight ingest so the daemon doesn't leave a torn
    // transaction behind on shutdown.
    if (ingestInFlight) {
      try {
        await ingestInFlight;
      } catch (e) {
        verbose(`watch: in-flight ingest at shutdown errored: ${errorMessage(e)}`);
      }
    }
    info("watch: shutdown complete");
  }
}

/**
 * Run one ingest cycle and log the outcome. Errors are caught and
 * logged but NOT rethrown — the daemon's job is to keep running across
 * transient failures (ollama hiccup, DB lock contention, etc.). A
 * subsequent fs event will trigger another attempt.
 */
async function runOneIngestCycle(
  opts: WatchOptions,
  ingest: (o: WatchOptions) => Promise<void>,
): Promise<void> {
  try {
    await ingest(opts);
  } catch (e) {
    warn(`watch: ingest failed: ${errorMessage(e)}`);
  }
}

async function defaultRunIngest(opts: WatchOptions): Promise<void> {
  await runIndex({
    archive: opts.archive,
    sourceDir: opts.sourceDir,
    sourceDb: opts.sourceDb,
    embedModel: opts.embedModel,
    ollamaHost: opts.ollamaHost,
    skipEmbeddings: opts.skipEmbeddings,
  });
}

/**
 * Recursive watch on the recordings tree. Every event triggers
 * `onEvent` — we don't filter by path inside the tree because Super
 * Whisper writes audio + meta.json under different subpaths and we
 * want to catch all of them.
 */
async function watchRecordings(
  sourceDir: string,
  signal: AbortSignal,
  onEvent: (reason: string) => void,
): Promise<void> {
  try {
    const watcher = watch(sourceDir, { recursive: true, signal });
    for await (const event of watcher) {
      onEvent(`recordings:${event.eventType}:${event.filename ?? "?"}`);
    }
  } catch (e) {
    if (signal.aborted) return;
    warn(`watch: recordings watcher errored: ${errorMessage(e)}`);
  }
}

/**
 * Non-recursive watch on the parent of `sourceDb`. SQLite's WAL mode
 * touches `swrag.sqlite-wal` and `swrag.sqlite-shm` constantly, so we
 * also wake on those — they're a strong proxy for "the DB just got
 * written". Filtering to the family avoids waking on every unrelated
 * file under `~/Library/Application Support/superwhisper/database/`
 * (in practice it's empty other than the DB family, but defensive).
 */
async function watchSourceDb(
  parentDir: string,
  sourceDb: string,
  signal: AbortSignal,
  onEvent: (reason: string) => void,
): Promise<void> {
  const dbBaseName = sourceDb.slice(parentDir.length + 1);
  try {
    const watcher = watch(parentDir, { recursive: false, signal });
    for await (const event of watcher) {
      const fn = event.filename ?? "";
      if (fn === dbBaseName || fn.startsWith(`${dbBaseName}-`)) {
        onEvent(`sourceDb:${event.eventType}:${fn}`);
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    warn(`watch: source DB watcher errored: ${errorMessage(e)}`);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
