/**
 * TypeScript wrapper around the Swift `swrag-helper` binary.
 *
 * The helper exists because a handful of macOS-only APIs need direct
 * access:
 *   - `NSWorkspace.shared.{frontmostApplication,runningApplications}`
 *   - CoreAudio property listeners on `kAudioDevicePropertyDeviceIsRunningSomewhere`
 *   - `AVCaptureDevice.authorizationStatus(for: .audio)` / `requestAccess`
 *   - `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`
 *   - `UNUserNotificationCenter` (the `notify` subcommand)
 *
 * Starting in v0.9.0, the helper ships as a code-signed `.app` bundle
 * at `vendor/swrag-helper.app/` rather than a raw Mach-O. macOS TCC
 * identifies a raw binary by (absolute path + checksum), so every
 * `brew upgrade` revoked Screen Recording / Microphone grants because
 * the materialised path's size suffix changed. A `.app` is identified
 * by (CFBundleIdentifier + ad-hoc signature), so grants now survive
 * upgrades. Bundling is also a hard prerequisite for
 * `UNUserNotificationCenter`.
 *
 * The bundle is tarballed at build time into
 * `vendor/swrag-helper.app.tar`, embedded into the compiled swrag
 * CLI via `with { type: "file" }`, and extracted on first use to a
 * stable per-user cache path. Stable path matters: TCC's ad-hoc-sign
 * heuristics give the most reliable grant-persistence when the .app
 * lives at the same absolute path on every upgrade.
 *
 * Every cross-process payload is validated through a zod schema in
 * this file. The detector / daemon consumes only inferred TS types,
 * never raw JSON.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { verbose, warn } from "../log.ts";
import embeddedHelperTar from "../../vendor/swrag-helper.app.tar" with { type: "file" };

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
  // care about the seven well-known browsers — Safari, Chrome, Brave,
  // Arc, Vivaldi, Edge, Comet — but parsing is intentionally permissive
  // so a future Swift-side addition doesn't break TS first).
  automation: z.record(z.string(), PermissionStateSchema),
  // Notifications: tracked starting in v0.9.0 once the helper became a
  // .app bundle (UNUserNotificationCenter requires bundle identity).
  // `.provisional` is a real APNs state for opt-in-without-asking
  // alerts; we surface it through to the doctor output unchanged.
  notifications: z.enum(["granted", "denied", "not_determined", "provisional"]),
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
/* Helper-bundle path resolution                                              */
/* -------------------------------------------------------------------------- */

let cachedHelperBinaryPath: string | null = null;
let cachedHelperAppPath: string | null = null;

/**
 * Returns an absolute, executable path to the Swift helper binary
 * (the inner `Contents/MacOS/swrag-helper` of the .app bundle).
 *
 * Resolution order:
 *   1. SWRAG_HELPER_PATH env var override (test hook). If the override
 *      is a directory ending in `.app`, we resolve to its inner
 *      `Contents/MacOS/swrag-helper`. If it's a file, we use it
 *      verbatim (legacy compat for tests that point at a raw binary).
 *   2. Dev mode: the bundle exists at `vendor/swrag-helper.app/` on
 *      disk; run the inner binary directly.
 *   3. Compiled bundle: extract the embedded `vendor/swrag-helper.app.tar`
 *      to a per-user cache dir, then return the inner binary path.
 *
 * Extraction is gated on a per-tarball-size marker file — if the
 * marker matches and the inner binary exists, we reuse the on-disk
 * bundle without re-extracting. The cache path is intentionally
 * stable across versions: TCC's ad-hoc-sign heuristics for
 * permission-grant persistence on `brew upgrade` are most reliable
 * when (bundle id, absolute path) both stay the same.
 */
export function helperBinaryPath(): string {
  if (cachedHelperBinaryPath) return cachedHelperBinaryPath;
  const override = process.env.SWRAG_HELPER_PATH;
  if (override && existsSync(override)) {
    cachedHelperBinaryPath = resolveOverridePath(override);
    return cachedHelperBinaryPath;
  }
  if (process.platform !== "darwin") {
    throw new Error(
      `swrag-helper: unsupported platform: ${process.platform} (only darwin is supported)`,
    );
  }
  const { binary, app } = materialiseHelper(embeddedHelperTar);
  cachedHelperBinaryPath = binary;
  cachedHelperAppPath = app;
  return cachedHelperBinaryPath;
}

/**
 * Returns the absolute path to the materialised `swrag-helper.app/`
 * directory. In dev mode this is `vendor/swrag-helper.app`; at
 * runtime it's the extracted cache directory. The `notify`
 * subcommand needs this (rather than the inner binary path) when
 * we want to launch the bundle via `open` instead of executing the
 * inner binary directly — running through `open` gives the helper a
 * fresh app activation context which `UNUserNotificationCenter`
 * relies on. Today we still spawn the inner binary directly (it
 * works because Foundation walks up to find the .app context) but
 * we expose the path here for future flexibility.
 */
export function helperAppPath(): string {
  if (cachedHelperAppPath) return cachedHelperAppPath;
  // Force resolution.
  helperBinaryPath();
  if (cachedHelperAppPath == null) {
    throw new Error("swrag-helper: app path resolution failed");
  }
  return cachedHelperAppPath;
}

function resolveOverridePath(override: string): string {
  // Override may be either a .app directory or a raw binary path. If
  // it's a directory and looks like a bundle, peek inside.
  try {
    const stat = statSync(override);
    if (stat.isDirectory()) {
      const inner = join(override, "Contents", "MacOS", "swrag-helper");
      if (existsSync(inner)) {
        cachedHelperAppPath = override;
        return inner;
      }
    } else {
      // Raw-binary override: try to infer the enclosing .app from
      // path conventions; otherwise leave the app path unset and
      // hope the caller doesn't ask for it.
      const maybeApp = inferAppFromBinaryPath(override);
      if (maybeApp != null) cachedHelperAppPath = maybeApp;
      return override;
    }
  } catch {
    // fall through
  }
  return override;
}

function inferAppFromBinaryPath(binPath: string): string | null {
  // `…/swrag-helper.app/Contents/MacOS/swrag-helper` → `…/swrag-helper.app`
  const macosDir = dirname(binPath);
  const contentsDir = dirname(macosDir);
  const appDir = dirname(contentsDir);
  if (appDir.endsWith(".app") && existsSync(appDir)) return appDir;
  return null;
}

interface MaterialisedHelper {
  /** Absolute path to the inner Mach-O. */
  binary: string;
  /** Absolute path to the .app directory. */
  app: string;
}

function materialiseHelper(embedded: string): MaterialisedHelper {
  // Dev path: when running under `bun src/cli.ts`, the embedded
  // reference is a real fs path to `vendor/swrag-helper.app.tar`.
  // The sibling `swrag-helper.app/` is already on disk from
  // `scripts/build-swift-helper.sh`; run it in place without paying
  // the extract cost.
  if (!embedded.startsWith("/$bunfs/")) {
    const sibling = embedded.replace(/\.tar$/, "");
    const innerBin = join(sibling, "Contents", "MacOS", "swrag-helper");
    if (existsSync(innerBin)) {
      return { binary: innerBin, app: sibling };
    }
    // No sibling — fall through to tarball extraction. Happens when
    // the dev only has the tarball checked in (rare) or when the
    // build script removed the .app for some reason.
  }

  const data = readFileSync(embedded);
  const size = data.byteLength;
  const cacheDir = join(tmpdir(), `swrag-helper-${safeUid()}-${safeUsername()}`);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(cacheDir, 0o700);
  } catch {
    // ignore — pre-existing dirs from other invocations are fine.
  }
  // Clean up v0.8.x leftovers: the previous materialiser wrote a
  // single-file `swrag-helper-universal-<size>` per-tarball-size into
  // the same cache directory. Those raw binaries are dead weight in
  // v0.9.0 — silently remove them so cache dirs stay slim across the
  // upgrade. Best-effort: a failure here doesn't affect correctness.
  try {
    const Bun_ = (globalThis as { Bun?: { Glob: new (s: string) => { scanSync(opts: { cwd: string }): Iterable<string> } } }).Bun;
    if (Bun_?.Glob) {
      const matches = new Bun_.Glob("swrag-helper-universal-*").scanSync({ cwd: cacheDir });
      for (const name of matches) {
        try {
          rmSync(join(cacheDir, name), { force: true });
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // best-effort
  }
  const appPath = join(cacheDir, "swrag-helper.app");
  const innerBin = join(appPath, "Contents", "MacOS", "swrag-helper");
  const sizeMarker = join(cacheDir, `.tar-size-${size}`);

  // Fast path: the marker for THIS tarball size exists AND the
  // inner binary exists. Reuse the extracted bundle.
  if (existsSync(sizeMarker) && existsSync(innerBin)) {
    return { binary: innerBin, app: appPath };
  }

  // Stage in a per-pid tmp dir, then atomically swap. This avoids
  // tearing down an in-use bundle while another swrag invocation
  // might be reading from it.
  const stagingTarFile = join(cacheDir, `swrag-helper.app.${process.pid}.tar.tmp`);
  const stagingExtractDir = join(cacheDir, `swrag-helper.app.${process.pid}.staging`);
  try {
    writeFileSync(stagingTarFile, data, { mode: 0o600 });
    try {
      rmSync(stagingExtractDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    mkdirSync(stagingExtractDir, { recursive: true, mode: 0o700 });
    // Extract via system `tar`. macOS ships BSD tar; we built the
    // archive with that same `tar`, so quirks (resource forks etc.)
    // round-trip cleanly. `--no-xattrs` skips the noisy extended-
    // attribute restoration which we don't rely on.
    const r = Bun.spawnSync({
      cmd: ["tar", "-xf", stagingTarFile, "-C", stagingExtractDir],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      const stderr = new TextDecoder().decode(r.stderr);
      throw new Error(`tar extract failed: ${stderr.trim() || `exit ${r.exitCode}`}`);
    }
    const stagedApp = join(stagingExtractDir, "swrag-helper.app");
    if (!existsSync(join(stagedApp, "Contents", "MacOS", "swrag-helper"))) {
      throw new Error(
        `tar extract produced no inner binary at ${stagedApp}/Contents/MacOS/swrag-helper`,
      );
    }
    // Swap the new bundle into place. We rm the old target first
    // (rename(2) refuses to overwrite a non-empty directory on
    // every common filesystem). Two concurrent extractors will
    // race here — the loser's rename will throw EEXIST or ENOTEMPTY
    // and we fall through to the existsSync recheck.
    //
    // v0.9.5: if rename trips ENOTEMPTY/EEXIST we retry once after
    // another rmSync. We've seen the race surface on first-kickstart
    // after `brew upgrade` (v0.9.2 + v0.9.4) when both the
    // meeting-watch and meeting-menubar launchd jobs materialise the
    // helper concurrently: process A finishes its rename in the
    // window between B's rmSync and B's rename, and B's rename then
    // sees A's freshly-landed bundle. A single retry resolves this
    // 99% of the time — same content in both staged trees, so the
    // second rename either succeeds (B wins after re-clean) or fails
    // again and falls through to the existsSync(innerBin) handoff.
    try {
      rmSync(appPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      renameSync(stagedApp, appPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isRaceErr = /ENOTEMPTY|EEXIST/.test(msg);
      let recovered = false;
      if (isRaceErr) {
        try {
          rmSync(appPath, { recursive: true, force: true });
          renameSync(stagedApp, appPath);
          recovered = true;
        } catch {
          // fall through
        }
      }
      if (!recovered && !existsSync(innerBin)) {
        throw new Error(
          `swrag-helper: bundle materialisation failed: ${msg}`,
        );
      }
      // Either we recovered on retry, or another extractor finished
      // first and left a usable innerBin in place.
    }
    // Drop the size marker last so a half-finished extract isn't
    // mistakenly reused on the next call.
    try {
      writeFileSync(sizeMarker, "", { mode: 0o600 });
    } catch {
      // best-effort
    }
  } finally {
    try {
      rmSync(stagingTarFile, { force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(stagingExtractDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  if (!existsSync(innerBin)) {
    throw new Error(
      `swrag-helper: bundle materialisation produced no inner binary at ${innerBin}`,
    );
  }
  return { binary: innerBin, app: appPath };
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

/* -------------------------------------------------------------------------- */
/* notify — UNUserNotificationCenter banner with action buttons              */
/* -------------------------------------------------------------------------- */

/**
 * Result of a `notify` invocation, validated through a literal union.
 * Anything outside the union — and any helper-side failure — is
 * surfaced as `"timeout"` by the caller so the daemon never blocks
 * a meeting on a notification path failure.
 */
const NotifyResultSchema = z.union([
  z.literal("record"),
  z.literal("skip"),
  z.literal("timeout"),
]);
export type NotifyResult = z.infer<typeof NotifyResultSchema>;

export interface FireStartRecordingNotificationOptions {
  /** Body text of the banner; the title is fixed. */
  reason: string;
  /** Auto-dismiss the banner after this many seconds. Defaults to 90. */
  timeoutSeconds?: number;
  /** Override helper path for tests. */
  helperPath?: string;
  /** Per-call exec stub for tests. */
  exec?: NotifyExecFn;
}

export interface NotifyExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type NotifyExecFn = (cmd: string[]) => Promise<NotifyExecResult>;

const DEFAULT_NOTIFY_TIMEOUT_SEC = 90;
// Buffer above the helper-side timeout so we never SIGKILL the helper
// in the middle of its own timeout-cleanup path. The helper sets up
// a DispatchSource timer that calls CFRunLoopStop on the main loop;
// give that ~3 s to drain after the deadline.
const NOTIFY_PROCESS_BUFFER_MS = 3_000;

/**
 * Fire a native UNUserNotificationCenter banner with Record / Skip
 * action buttons. Returns the chosen action lowercased, or
 * `"timeout"` on banner expiry / dismiss.
 *
 * This is the v0.9.0 replacement for `askStartRecording`'s modal
 * `osascript display dialog`. The banner is non-modal — it slides
 * down from the top-right and the user can ignore it without
 * stealing focus from whatever meeting tool they're already in.
 *
 * Failure modes (all return `"timeout"` rather than throwing, so the
 * daemon never crashes on a notification path):
 *   - Helper binary missing or exits non-zero (e.g. auth denied)
 *   - Helper output doesn't match the schema
 *   - Spawn-level error
 * A warning is logged in every failure case so SWRAG_VERBOSE surfaces
 * the underlying reason.
 */
export async function fireStartRecordingNotification(
  opts: FireStartRecordingNotificationOptions,
): Promise<NotifyResult> {
  const timeoutSec = opts.timeoutSeconds ?? DEFAULT_NOTIFY_TIMEOUT_SEC;
  const exec = opts.exec ?? defaultNotifyExec;
  let bin: string;
  try {
    bin = opts.helperPath ?? helperBinaryPath();
  } catch (e) {
    warn(`fireStartRecordingNotification: helper unresolved: ${errToString(e)}`);
    return "timeout";
  }
  const args = [
    bin,
    "notify",
    "--title",
    "Meeting detected",
    "--body",
    opts.reason,
    "--actions",
    "Record,Skip",
    "--default-action",
    "Record",
    "--timeout",
    String(timeoutSec),
  ];
  let result: NotifyExecResult;
  try {
    result = await exec(args);
  } catch (e) {
    warn(`fireStartRecordingNotification: spawn failed: ${errToString(e)}`);
    return "timeout";
  }
  if (result.exitCode !== 0) {
    warn(
      `fireStartRecordingNotification: helper exit=${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    return "timeout";
  }
  const raw = result.stdout.trim().split("\n").pop()?.trim() ?? "";
  const parsed = NotifyResultSchema.safeParse(raw);
  if (!parsed.success) {
    warn(`fireStartRecordingNotification: unexpected stdout ${JSON.stringify(raw)}`);
    return "timeout";
  }
  return parsed.data;
}

const defaultNotifyExec: NotifyExecFn = async (cmd: string[]): Promise<NotifyExecResult> => {
  const timeoutSec = parseTimeoutFromArgs(cmd) ?? DEFAULT_NOTIFY_TIMEOUT_SEC;
  const [bin, ...rest] = cmd;
  if (bin == null) {
    return { exitCode: -1, stdout: "", stderr: "fireStartRecordingNotification: empty cmd" };
  }
  const proc = Bun.spawn([bin, ...rest], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Kill the helper if it overruns its own timeout by a wide margin.
    // The helper's main.swift drives a DispatchSource timer to stop
    // the run loop at the configured `--timeout`; this acts as a
    // belt-and-braces safety net.
    timeout: timeoutSec * 1000 + NOTIFY_PROCESS_BUFFER_MS,
  });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  const exitCode = await proc.exited;
  verbose(`swrag-helper notify exit=${exitCode} stdout=${stdout.trim()}`);
  return { exitCode, stdout, stderr };
};

function parseTimeoutFromArgs(cmd: string[]): number | null {
  const idx = cmd.indexOf("--timeout");
  if (idx === -1 || idx === cmd.length - 1) return null;
  const value = Number(cmd[idx + 1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function errToString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
