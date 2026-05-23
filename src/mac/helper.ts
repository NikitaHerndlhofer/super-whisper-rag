/**
 * TypeScript wrapper around the Swift `swrag-helper` binary.
 *
 * The helper exists because four macOS-only APIs need direct access:
 *   - `NSWorkspace.shared.{frontmostApplication,runningApplications}`
 *   - CoreAudio property listeners on `kAudioDevicePropertyDeviceIsRunningSomewhere`
 *   - `AVCaptureDevice.authorizationStatus(for: .audio)` / `requestAccess`
 *   - `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`
 *
 * One universal Mach-O ships at `vendor/swrag-helper-darwin-universal`.
 * At dev time we resolve the path from the repo's `vendor/`; inside a
 * `bun build --compile` binary the helper is embedded via `with { type:
 * "file" }` and materialised on first use to a per-user cache dir (see
 * `src/archive/vec-loader.ts` for the same pattern applied to vec0).
 *
 * Every output crosses a process boundary, so every output is parsed
 * through a zod schema in this file. The detector / daemon consumes
 * only the inferred TS types, never the raw JSON.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { verbose } from "../log.ts";
import embeddedHelperPath from "../../vendor/swrag-helper-darwin-universal" with { type: "file" };

/* -------------------------------------------------------------------------- */
/* Schemas — every cross-process payload validated through one of these.      */
/* -------------------------------------------------------------------------- */

export const FrontmostAppSchema = z.object({
  bundleId: z.string().nullable(),
  name: z.string().nullable(),
  pid: z.number().int().nullable(),
  runningCallApps: z.object({
    strict: z.array(z.string()),
    soft: z.array(z.string()),
  }),
});
export type FrontmostApp = z.infer<typeof FrontmostAppSchema>;

export const MicInUseSchema = z.object({
  inUse: z.boolean(),
  owners: z.array(z.string()),
});
export type MicInUse = z.infer<typeof MicInUseSchema>;

const PermissionStateSchema = z.enum(["granted", "denied", "not_determined", "not_installed"]);
export type PermissionState = z.infer<typeof PermissionStateSchema>;

export const PermissionsSchema = z.object({
  microphone: z.enum(["granted", "denied", "not_determined"]),
  screen_recording: z.enum(["granted", "denied", "not_determined"]),
  // Per-bundle-id automation status. Keys are arbitrary strings (we
  // care about the six well-known browsers, but parsing is intentionally
  // permissive so a future Swift-side addition doesn't break TS first).
  automation: z.record(z.string(), PermissionStateSchema),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

/* -------------------------------------------------------------------------- */
/* Event-stream schemas (events subcommand)                                   */
/* -------------------------------------------------------------------------- */

export const SnapshotEventSchema = z.object({
  event: z.literal("snapshot"),
  frontmost: z.object({
    bundleId: z.string().nullable(),
    name: z.string().nullable(),
    pid: z.number().int().nullable(),
  }),
  mic: z.object({
    in_use: z.boolean(),
    owners: z.array(z.string()),
  }),
  running_call_apps: z.object({
    strict: z.array(z.string()),
    soft: z.array(z.string()),
  }),
});
export type SnapshotEvent = z.infer<typeof SnapshotEventSchema>;

export const FrontmostChangedEventSchema = z.object({
  event: z.literal("frontmost_changed"),
  bundle_id: z.string().nullable(),
  name: z.string().nullable(),
  pid: z.number().int().nullable(),
});

export const AppLaunchedEventSchema = z.object({
  event: z.literal("app_launched"),
  bundle_id: z.string().nullable(),
  name: z.string().nullable(),
  pid: z.number().int().nullable(),
});

export const AppTerminatedEventSchema = z.object({
  event: z.literal("app_terminated"),
  bundle_id: z.string().nullable(),
  name: z.string().nullable(),
  pid: z.number().int().nullable(),
});

export const MicChangedEventSchema = z.object({
  event: z.literal("mic_changed"),
  in_use: z.boolean(),
  owners: z.array(z.string()),
});

export const EventLineSchema = z.discriminatedUnion("event", [
  SnapshotEventSchema,
  FrontmostChangedEventSchema,
  AppLaunchedEventSchema,
  AppTerminatedEventSchema,
  MicChangedEventSchema,
]);
export type EventLine = z.infer<typeof EventLineSchema>;

/* -------------------------------------------------------------------------- */
/* record subcommand — heartbeat schema + spawn wrapper                       */
/* -------------------------------------------------------------------------- */

/**
 * One NDJSON heartbeat emitted by `swrag-helper record` ~once per second.
 *
 * `frames` is the total mono frames written to the WAV so far (post-mix).
 * `duration_ms` is `frames / 16` (target sample rate is 16 kHz).
 * `level_dbfs` is the peak absolute amplitude of the last second mapped
 * to dBFS; on a fully-silent second the helper clamps to a finite value
 * (currently -160) so the JSON stays parseable.
 */
export const RecorderHeartbeatSchema = z.object({
  frames: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  level_dbfs: z.number().finite(),
});
export type RecorderHeartbeat = z.infer<typeof RecorderHeartbeatSchema>;

/* -------------------------------------------------------------------------- */
/* Helper-binary path resolution                                              */
/* -------------------------------------------------------------------------- */

let cachedHelperPath: string | null = null;

/**
 * Returns an absolute, executable path to the Swift helper.
 *
 * Resolution order:
 *   1. SWRAG_HELPER_PATH env var override (test hook).
 *   2. The embedded asset path. At dev time this is a real path under
 *      `vendor/`; in the compiled bundle it's `/$bunfs/...` and we
 *      materialise it into a per-user cache dir with `+x` so the OS
 *      can `execve()` it.
 */
export function helperBinaryPath(): string {
  if (cachedHelperPath) return cachedHelperPath;
  const override = process.env.SWRAG_HELPER_PATH;
  if (override && existsSync(override)) {
    cachedHelperPath = override;
    return cachedHelperPath;
  }
  if (process.platform !== "darwin") {
    throw new Error(
      `swrag-helper: unsupported platform: ${process.platform} (only darwin is supported)`,
    );
  }
  cachedHelperPath = materialiseHelper(embeddedHelperPath);
  return cachedHelperPath;
}

function materialiseHelper(embedded: string): string {
  if (!embedded.startsWith("/$bunfs/") && existsSync(embedded)) {
    // Dev mode — vendored file lives at a real path on disk. The
    // file is already executable from the build script's `chmod +x`,
    // so we can run it in place.
    return embedded;
  }
  const data = readFileSync(embedded);
  const size = data.byteLength;
  // Mirror `vec-loader.ts`'s per-user cache layout for symmetry.
  const cacheDir = join(tmpdir(), `swrag-helper-${safeUid()}-${safeUsername()}`);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(cacheDir, 0o700);
  } catch {
    // ignore — pre-existing dirs from other invocations are fine.
  }
  const target = join(cacheDir, `swrag-helper-universal-${size}`);
  if (existsSync(target) && statSync(target).size === size) {
    return target;
  }
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o700 });
  try {
    renameSync(tmp, target);
  } catch {
    if (!existsSync(target) || statSync(target).size !== size) {
      throw new Error("swrag-helper: materialisation failed");
    }
  }
  try {
    chmodSync(target, 0o700);
  } catch {
    // best-effort; the write above already opened with 0o700.
  }
  return target;
}

function safeUsername(): string {
  try {
    return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");
  } catch {
    return "user";
  }
}

function safeUid(): string {
  const uid = process.getuid?.();
  return uid == null ? "x" : String(uid);
}

/* -------------------------------------------------------------------------- */
/* One-shot subcommands                                                       */
/* -------------------------------------------------------------------------- */

export interface OneShotOptions {
  /** Override the resolved helper binary path (test hook). */
  helperPath?: string;
  /** Per-call timeout in ms (default: 5_000 for one-shots). */
  timeoutMs?: number;
}

const DEFAULT_ONESHOT_TIMEOUT_MS = 5_000;
// permissions-check with `--prompt` may sit waiting on a user-facing
// dialog for up to a minute. We bump the timeout for that one path.
const PERMISSIONS_PROMPT_TIMEOUT_MS = 90_000;

async function runOneShot(args: string[], opts: OneShotOptions): Promise<string> {
  const bin = opts.helperPath ?? helperBinaryPath();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ONESHOT_TIMEOUT_MS;
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: timeoutMs,
  });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(
      `swrag-helper ${args.join(" ")} exited ${exit}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout;
}

export async function getFrontmostApp(opts: OneShotOptions = {}): Promise<FrontmostApp> {
  const out = await runOneShot(["frontmost-app"], opts);
  const json: unknown = JSON.parse(out);
  return FrontmostAppSchema.parse(json);
}

export async function isMicInUse(opts: OneShotOptions = {}): Promise<MicInUse> {
  const out = await runOneShot(["mic-in-use"], opts);
  const json: unknown = JSON.parse(out);
  return MicInUseSchema.parse(json);
}

export interface PermissionsOptions extends OneShotOptions {
  prompt?: boolean;
}

export async function getPermissions(opts: PermissionsOptions = {}): Promise<Permissions> {
  const args = ["permissions-check"];
  if (opts.prompt) args.push("--prompt");
  const effective: OneShotOptions = {
    helperPath: opts.helperPath,
    timeoutMs: opts.timeoutMs ?? (opts.prompt ? PERMISSIONS_PROMPT_TIMEOUT_MS : DEFAULT_ONESHOT_TIMEOUT_MS),
  };
  const out = await runOneShot(args, effective);
  const json: unknown = JSON.parse(out);
  return PermissionsSchema.parse(json);
}

/* -------------------------------------------------------------------------- */
/* events — long-running async iterator                                       */
/* -------------------------------------------------------------------------- */

export interface EventsHandle {
  /**
   * AsyncIterable of validated event lines from the helper's stdout.
   * Iteration ends on EOF (helper exits) or when `stop()` is called.
   */
  events: AsyncIterable<EventLine>;
  /**
   * SIGTERM the helper subprocess and wait for it to exit. Idempotent.
   * Always call this when you're done iterating, even on the happy
   * path — leaking a child process is what we go out of our way to
   * prevent in the daemon.
   */
  stop: () => Promise<void>;
  /**
   * Most-recent ~8 KB of stderr emitted by the helper subprocess, with
   * trailing whitespace trimmed. Useful when the iterator ends without
   * ever yielding the expected events: the caller can include this in
   * an error message to surface a Swift-side crash trace or warning.
   */
  stderrTail: () => string;
}

export interface SpawnEventsOptions {
  helperPath?: string;
  /**
   * If true, malformed JSON lines (or lines that don't satisfy
   * `EventLineSchema`) are silently dropped. The default (false)
   * surfaces them as exceptions on the iterator so we don't lose
   * signal in production.
   */
  ignoreInvalidLines?: boolean;
}

/**
 * Spawn `swrag-helper events`. Returns an `AsyncIterable` of validated
 * events plus a `stop()` lifecycle hook.
 *
 * Implementation notes:
 *   - We read stdout line-by-line via Bun's stream API. Helper writes
 *     one JSON object per line (`setlinebuf(stdout)` on the Swift side).
 *   - Iteration is single-consumer. If you need to fan out to multiple
 *     subscribers, do the multiplexing in the consumer.
 */
export function spawnEventsHelper(opts: SpawnEventsOptions = {}): EventsHandle {
  const bin = opts.helperPath ?? helperBinaryPath();
  const proc = Bun.spawn([bin, "events"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  // Drain stderr concurrently with stdout. Two reasons:
  //   1) Sustained stderr output would back-pressure-block the helper
  //      once the pipe buffer (~64 KB on macOS) fills — eventually
  //      stalling stdout writes too because the helper blocks in
  //      `write()`.
  //   2) Without this, any Swift-side warning / crash trace is silently
  //      dropped on the floor. Callers (the CLI, the future daemon)
  //      have no way to diagnose helper failures.
  // We log every line via `verbose()` so SWRAG_VERBOSE surfaces them,
  // and we keep the most-recent 8 KB in `stderrTail` for callers to
  // attach to error messages.
  const STDERR_TAIL_LIMIT = 8 * 1024;
  let stderrTail = "";
  const stderrDrainPromise = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let leftover = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.length === 0) continue;
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
        leftover += chunk;
        let nl = leftover.indexOf("\n");
        while (nl !== -1) {
          const line = leftover.slice(0, nl);
          leftover = leftover.slice(nl + 1);
          if (line.length > 0) verbose(`swrag-helper events stderr: ${line}`);
          nl = leftover.indexOf("\n");
        }
      }
      if (leftover.trim().length > 0) {
        verbose(`swrag-helper events stderr: ${leftover.trim()}`);
      }
    } catch {
      // Reader closed mid-read (proc killed). The bytes we collected so
      // far are still in `stderrTail` — that's the best we can do.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  })();

  async function* iterate(): AsyncGenerator<EventLine, void, void> {
    let leftover = "";
    const decoder = new TextDecoder();
    // proc.stdout is a ReadableStream<Uint8Array>; iterate chunks.
    const reader = proc.stdout.getReader();
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        leftover += decoder.decode(value, { stream: true });
        let nl = leftover.indexOf("\n");
        while (nl !== -1) {
          const line = leftover.slice(0, nl).trim();
          leftover = leftover.slice(nl + 1);
          nl = leftover.indexOf("\n");
          if (line.length === 0) continue;
          try {
            const json: unknown = JSON.parse(line);
            const parsed = EventLineSchema.parse(json);
            yield parsed;
          } catch (e) {
            if (opts.ignoreInvalidLines) continue;
            throw new Error(
              `swrag-helper events: invalid line ${JSON.stringify(line)}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }
      }
      // Flush trailing partial line (helper exited mid-message).
      if (leftover.trim().length > 0) {
        try {
          const json: unknown = JSON.parse(leftover.trim());
          const parsed = EventLineSchema.parse(json);
          yield parsed;
        } catch {
          if (!opts.ignoreInvalidLines) {
            // Ignore trailing garbage on EOF — the helper might have
            // been SIGTERM'd mid-write; don't fail the iterator.
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  const events = iterate();

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
      try {
        await proc.exited;
      } catch {
        // best-effort
      }
      // Wait for the stderr drain to finish so the final tail is
      // visible to whoever called stop() (typically right before
      // reading stderrTail() for an error message). If the drain
      // itself rejects we don't propagate — it's a best-effort
      // diagnostic side channel.
      try {
        await stderrDrainPromise;
      } catch {
        // best-effort
      }
    })();
    return stopPromise;
  }

  return {
    events,
    stop,
    stderrTail: () => stderrTail.trim(),
  };
}

/* -------------------------------------------------------------------------- */
/* record — long-running recorder subprocess                                  */
/* -------------------------------------------------------------------------- */

export interface RecorderOptions {
  /** Where the Swift helper writes the WAV. Absolute path. */
  outputPath: string;
  /** Pass `--system-audio` to the helper if true. */
  captureSystemAudio: boolean;
  /** Optional callback invoked for every validated heartbeat. */
  onHeartbeat?: (payload: RecorderHeartbeat) => void;
  helperPath?: string;
  /**
   * Drop malformed stdout lines instead of throwing on the iterator.
   * Defaults to true: the Swift helper emits a "stopped" summary line
   * with a slightly different shape during shutdown, which we don't
   * surface as a recorder heartbeat. We want one knob to silence that
   * (and any other future non-heartbeat NDJSON) without losing the
   * actual diagnostic stream.
   */
  ignoreInvalidLines?: boolean;
}

export interface RecorderStopResult {
  exitCode: number;
  stderr: string;
}

export interface RecorderHandle {
  /**
   * AsyncIterable of validated heartbeats. Each `[Symbol.asyncIterator]()`
   * call returns a fresh iterator that catches heartbeats from the
   * moment it subscribes onward (no replay). Use `firstHeartbeat()`
   * for a guarantee that you'll see the very first event regardless
   * of subscribe timing.
   */
  events: AsyncIterable<RecorderHeartbeat>;
  /**
   * Promise that resolves with the very first heartbeat the helper
   * emits, or rejects if the helper exits before emitting one. Set
   * up synchronously at spawn time so callers can `await` it without
   * racing the drain loop.
   */
  firstHeartbeat: () => Promise<RecorderHeartbeat>;
  /**
   * SIGTERM the recorder, await exit, await stderr drain. If
   * `discard` is true, the WAV at `outputPath` is unlinked after the
   * subprocess exits (so callers don't have to mirror the cleanup
   * logic at every callsite).
   */
  stop: (opts?: { discard?: boolean }) => Promise<RecorderStopResult>;
  /** PID of the spawned subprocess. Useful for diagnostics + signals. */
  pid: number;
  /** Most-recent ~8 KB of stderr, trimmed. Surfaced on stop or failure. */
  stderrTail: () => string;
}

/**
 * Spawn `swrag-helper record --output <path> [--system-audio]`.
 *
 * Mirrors the shape of `spawnEventsHelper`: line-buffered NDJSON on
 * stdout, validated via zod and yielded through an AsyncIterable; a
 * concurrent stderr drain so the helper never back-pressure-stalls
 * on a full pipe; a `stop()` lifecycle hook that's safe to call twice.
 *
 * The recorder is foreground from the caller's POV: it runs until
 * SIGTERM, at which point the Swift side flushes + closes the WAV
 * and exits 0. Failures (mic permission denied, screen recording
 * permission denied) come through as non-zero exits with a stderr
 * message — the caller surfaces those after `stop()`.
 */
export function spawnRecorder(opts: RecorderOptions): RecorderHandle {
  const bin = opts.helperPath ?? helperBinaryPath();
  const args = ["record", "--output", opts.outputPath];
  if (opts.captureSystemAudio) args.push("--system-audio");
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const ignoreInvalid = opts.ignoreInvalidLines ?? true;
  let stopPromise: Promise<RecorderStopResult> | null = null;

  // Same stderr-drain pattern as spawnEventsHelper. Without this the
  // recorder would stall when stderr fills the OS pipe buffer (~64 KB
  // on macOS), and the heartbeat stream on stdout would freeze too
  // because the Swift side blocks in `write()`. Phase 2 already paid
  // the cost of figuring this out; we reuse the same shape verbatim.
  const STDERR_TAIL_LIMIT = 8 * 1024;
  let stderrTail = "";
  const stderrDrainPromise = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let leftover = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.length === 0) continue;
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
        leftover += chunk;
        let nl = leftover.indexOf("\n");
        while (nl !== -1) {
          const line = leftover.slice(0, nl);
          leftover = leftover.slice(nl + 1);
          if (line.length > 0) verbose(`swrag-helper record stderr: ${line}`);
          nl = leftover.indexOf("\n");
        }
      }
      if (leftover.trim().length > 0) {
        verbose(`swrag-helper record stderr: ${leftover.trim()}`);
      }
    } catch {
      // best-effort
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  })();

  // Heartbeat broadcaster.
  //
  // The recorder is a push-shaped source (the helper writes heartbeats
  // every ~1 s whether or not anyone is listening) AND we want to
  // support multiple consumption patterns: an `onHeartbeat` callback
  // for fire-and-forget callers, plus an `AsyncIterable` for callers
  // that want to await events explicitly. A naive generator-based
  // implementation conflates the two — the generator body only runs
  // when something pulls, so `onHeartbeat` would only fire while an
  // iterator is being consumed.
  //
  // Fix: drain stdout eagerly in a background task, push each parsed
  // heartbeat to all current AsyncIterator subscribers + invoke
  // `onHeartbeat`. Late subscribers don't replay history (we don't
  // need it for this product — the consumer always starts iterating
  // before the recorder begins emitting); they pick up from the next
  // heartbeat.
  type Listener = (hb: RecorderHeartbeat | null) => void;
  const listeners = new Set<Listener>();
  let stdoutDone = false;
  let stdoutError: Error | null = null;
  const onHeartbeatRaw = opts.onHeartbeat;

  // Dedicated "first heartbeat" promise. Set up synchronously so the
  // resolver is in place before the drain starts pumping events —
  // this eliminates the race where startRecording subscribes too late
  // and misses the first heartbeat.
  let firstHeartbeatResolve: ((hb: RecorderHeartbeat) => void) | null = null;
  let firstHeartbeatReject: ((err: Error) => void) | null = null;
  const firstHeartbeatPromise = new Promise<RecorderHeartbeat>((resolve, reject) => {
    firstHeartbeatResolve = resolve;
    firstHeartbeatReject = reject;
  });
  // Attach a no-op catch so a never-awaited rejection doesn't surface
  // as an unhandled-promise warning. Callers that DO await it still
  // see the rejection via the original promise.
  firstHeartbeatPromise.catch(() => {});
  let firstHeartbeatSettled = false;
  const dispatchFirstHeartbeat = (hb: RecorderHeartbeat): void => {
    if (firstHeartbeatSettled) return;
    firstHeartbeatSettled = true;
    const r = firstHeartbeatResolve;
    firstHeartbeatResolve = null;
    firstHeartbeatReject = null;
    r?.(hb);
  };
  const rejectFirstHeartbeat = (err: Error): void => {
    if (firstHeartbeatSettled) return;
    firstHeartbeatSettled = true;
    const r = firstHeartbeatReject;
    firstHeartbeatResolve = null;
    firstHeartbeatReject = null;
    r?.(err);
  };

  const stdoutDrainPromise = (async () => {
    let leftover = "";
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        leftover += decoder.decode(value, { stream: true });
        let nl = leftover.indexOf("\n");
        while (nl !== -1) {
          const line = leftover.slice(0, nl).trim();
          leftover = leftover.slice(nl + 1);
          nl = leftover.indexOf("\n");
          if (line.length === 0) continue;
          let json: unknown;
          try {
            json = JSON.parse(line);
          } catch {
            if (ignoreInvalid) continue;
            stdoutError = new Error(
              `swrag-helper record: invalid JSON line ${JSON.stringify(line)}`,
            );
            break;
          }
          const parsed = RecorderHeartbeatSchema.safeParse(json);
          if (!parsed.success) {
            // Non-heartbeat NDJSON (e.g. the "stopped" shutdown summary).
            // Drop quietly unless the caller explicitly opted in to
            // strict parsing — the recorder is allowed to emit other
            // shapes.
            if (ignoreInvalid) {
              verbose(
                `swrag-helper record: skipping non-heartbeat line ${JSON.stringify(line)}`,
              );
              continue;
            }
            stdoutError = new Error(
              `swrag-helper record: line failed heartbeat schema: ${parsed.error.message}`,
            );
            break;
          }
          if (onHeartbeatRaw) {
            try {
              onHeartbeatRaw(parsed.data);
            } catch {
              // Don't let a misbehaving callback kill the drain.
            }
          }
          dispatchFirstHeartbeat(parsed.data);
          // Snapshot listeners (callbacks may add/remove themselves).
          for (const listener of [...listeners]) {
            try {
              listener(parsed.data);
            } catch {
              // Best-effort — the listener's job is to push into its
              // own queue; we don't let a bad listener stop the stream.
            }
          }
        }
        if (stdoutError) break;
      }
    } catch (e) {
      if (!stdoutError) stdoutError = e instanceof Error ? e : new Error(String(e));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      stdoutDone = true;
      // If the stream ended without ever emitting a heartbeat, fail
      // the firstHeartbeat promise so callers see a clear error
      // instead of hanging forever.
      if (!firstHeartbeatSettled) {
        rejectFirstHeartbeat(
          stdoutError ?? new Error("recorder exited before emitting a heartbeat"),
        );
      }
      // Signal end-of-stream to every subscriber.
      for (const listener of [...listeners]) {
        try {
          listener(null);
        } catch {
          // best-effort
        }
      }
    }
  })();

  /**
   * Each call to `[Symbol.asyncIterator]()` returns a fresh queue-backed
   * iterator. Heartbeats emitted while no iterator is alive are NOT
   * replayed — this is desired (every CLI / test consumer starts
   * iterating before the recorder runs, so there's nothing missed).
   */
  const events: AsyncIterable<RecorderHeartbeat> = {
    [Symbol.asyncIterator](): AsyncIterator<RecorderHeartbeat> {
      const queue: RecorderHeartbeat[] = [];
      let pendingResolve: ((r: IteratorResult<RecorderHeartbeat>) => void) | null = null;
      let closed = false;
      const listener: Listener = (hb) => {
        if (closed) return;
        if (hb == null) {
          // EOF: wake any pending pull with a done result.
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = null;
            r({ value: undefined, done: true });
          }
          return;
        }
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r({ value: hb, done: false });
        } else {
          queue.push(hb);
        }
      };
      listeners.add(listener);

      const dispose = (): void => {
        if (closed) return;
        closed = true;
        listeners.delete(listener);
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r({ value: undefined, done: true });
        }
      };

      return {
        next(): Promise<IteratorResult<RecorderHeartbeat>> {
          if (closed) return Promise.resolve({ value: undefined, done: true });
          if (queue.length > 0) {
            const head = queue.shift();
            // Type-narrowing: `length > 0` guarantees `shift()` returns
            // a `RecorderHeartbeat`, but TS can't see that.
            if (head != null) {
              return Promise.resolve({ value: head, done: false });
            }
          }
          if (stdoutDone) {
            dispose();
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<RecorderHeartbeat>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<RecorderHeartbeat>> {
          dispose();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(e: unknown): Promise<IteratorResult<RecorderHeartbeat>> {
          dispose();
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        },
      };
    },
  };

  async function stop(stopOpts: { discard?: boolean } = {}): Promise<RecorderStopResult> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
      let exitCode = -1;
      try {
        exitCode = await proc.exited;
      } catch {
        // best-effort
      }
      // Drain both pipes before declaring stop complete: the stderr
      // drain has the diagnostic tail, the stdout drain has any final
      // heartbeats. Both promises resolve once the underlying pipe
      // hits EOF (which happens as part of the subprocess exit), so
      // by here they're at-or-near completion.
      try {
        await stderrDrainPromise;
      } catch {
        // best-effort
      }
      try {
        await stdoutDrainPromise;
      } catch {
        // best-effort
      }
      if (stopOpts.discard) {
        // Best-effort unlink — if the wav was never created (the
        // helper failed at start), this is a no-op. We never throw
        // from stop(); callers rely on the exit code + stderr tail
        // for failure reporting.
        try {
          if (existsSync(opts.outputPath)) {
            await unlink(opts.outputPath);
          }
        } catch {
          // best-effort
        }
      }
      return { exitCode, stderr: stderrTail.trim() };
    })();
    return stopPromise;
  }

  return {
    events,
    firstHeartbeat: () => firstHeartbeatPromise,
    stop,
    pid: proc.pid,
    stderrTail: () => stderrTail.trim(),
  };
}
