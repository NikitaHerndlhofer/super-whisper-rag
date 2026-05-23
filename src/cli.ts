import { defineCommand, runMain } from "citty";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { VERSION } from "./config.ts";
import { getEnv } from "./env.ts";
import { error, info } from "./log.ts";
import { resolvePaths, type ResolvedPaths } from "./paths.ts";
import type { Env } from "./schemas.ts";
import { runBootstrap } from "./commands/bootstrap.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runEmbed } from "./commands/embed.ts";
import { disableWatcher, enableWatcher } from "./commands/enable-watcher.ts";
import { runIndex } from "./commands/index.ts";
import { installSkill } from "./commands/install-skill.ts";
import { getPath, PathTargetSchema } from "./commands/path.ts";
import { runSql, readSqlInput } from "./commands/sql.ts";
import { getConfig, openArchive, setConfig } from "./archive/open.ts";
import { MeetingDetector } from "./meeting/detect.ts";
import * as meetingQueue from "./meeting/queue.ts";
import { MeetingProcessor, readState } from "./meeting/processor.ts";
import {
  startRecording,
  stopRecording,
  type RecordingHandle,
} from "./meeting/record.ts";
import { runDaemonForeground } from "./meeting/daemon.ts";
import { callDaemon, DaemonUnavailableError, isDaemonRunning } from "./meeting/daemon-client.ts";
import { helperBinaryPath, getPermissions, spawnEventsHelper } from "./mac/helper.ts";

// The CLI surface is intentionally tiny — zero flags. Everything that used
// to be a flag is an env var, parsed and validated through `getEnv()`.
// See `src/schemas.ts` for the full list of `SWRAG_*` vars, and the
// README's "Configuration" table for the user-facing summary.
//
// We defer the actual `getEnv()` / `resolvePaths()` call until a handler
// runs (rather than evaluating at module top level) so that
// `swrag --help` and `swrag --version` work even when the user has a
// malformed env var set — citty handles help-only invocations without
// dispatching to a subcommand handler.
interface Context {
  env: Env;
  paths: ResolvedPaths;
}

let _ctx: Context | null = null;
function ctx(): Context {
  if (_ctx) return _ctx;
  const env = getEnv();
  const paths = resolvePaths({
    sourceDir: env.SWRAG_SOURCE_DIR,
    sourceDb: env.SWRAG_SOURCE_DB,
    archive: env.SWRAG_ARCHIVE,
    ollamaHost: env.SWRAG_OLLAMA_HOST ?? env.OLLAMA_HOST,
    embedModel: env.SWRAG_EMBED_MODEL,
  });
  _ctx = { env, paths };
  return _ctx;
}

/**
 * Everything after a literal `--` on the command line. We detect this
 * here, before citty runs, because citty's positional parser doesn't
 * preserve the `--` boundary for us. Capturing it once at entry keeps
 * the handler code from reaching back into `process.argv`.
 */
const DASHDASH_INDEX = process.argv.indexOf("--");
const PASSTHROUGH_ARGS: readonly string[] =
  DASHDASH_INDEX < 0 ? [] : process.argv.slice(DASHDASH_INDEX + 1);

/**
 * True iff the user typed a positional argument BEFORE the `--`
 * separator. Citty's parser doesn't respect `--`, so its `args.query`
 * value will include positionals that appear after `--` as well — we
 * can't use it to tell "the user supplied inline SQL alongside
 * passthrough" from "the user supplied SQL inside the passthrough".
 * For the conflict-detection in `sqlCmd`, we have to scan argv
 * ourselves and check whether anything non-flag lives between the
 * subcommand and the `--`.
 *
 * `subcommand` is the literal we expect at `process.argv[2]`, e.g.
 * `"sql"`. The function returns true if there's a positional in
 * `process.argv[3..DASHDASH_INDEX)` — strict bounds, because argv[2]
 * is the subcommand name itself and DASHDASH_INDEX is the `--`.
 */
function hasInlinePositionalBeforeDashDash(subcommand: string): boolean {
  if (DASHDASH_INDEX < 0) return false;
  // process.argv layout under bun-compiled CLI: [bun_exec, subcommand, ...]
  // and DASHDASH_INDEX is the index of `--`. We look at the args
  // strictly between (subcommand_idx + 1) and DASHDASH_INDEX.
  const subIdx = process.argv.indexOf(subcommand);
  if (subIdx < 0 || subIdx >= DASHDASH_INDEX - 1) return false;
  for (let i = subIdx + 1; i < DASHDASH_INDEX; i++) {
    const a = process.argv[i];
    if (a == null) continue;
    // Treat anything that doesn't start with `-` as a positional. (The
    // sql subcommand exposes zero flags of its own, so any `-…` token
    // before `--` is the user's mistake — but it's not "inline SQL".)
    if (!a.startsWith("-")) return true;
  }
  return false;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Run `daemonOp` if the daemon is listening; otherwise run `inProcess`.
 * Centralises the "route through socket if available" pattern used by
 * queue/list, queue/state, etc. If the daemon is up but returns an
 * error or the protocol breaks mid-call, we don't fall back — the
 * caller's expectation is "talk to the live daemon" and silently
 * doing the work in-process would mask a real problem.
 */
async function viaDaemonOrFallback<T>(
  daemonOp: () => Promise<T>,
  inProcess: () => T | Promise<T>,
): Promise<T> {
  if (!(await isDaemonRunning())) return inProcess();
  try {
    return await daemonOp();
  } catch (e) {
    if (e instanceof DaemonUnavailableError) {
      // Daemon went away between the `isDaemonRunning` probe and our
      // op — rare race; fall back rather than confuse the user.
      return inProcess();
    }
    throw e;
  }
}

/* -------------------------------------------------------------------------- */
/* sql — thin proxy to the sqlite3 CLI                                        */
/* -------------------------------------------------------------------------- */

const sqlCmd = defineCommand({
  meta: {
    name: "sql",
    description:
      "Run SQL through sqlite3 (vec preloaded, archive read-only, ingest first). Omit positional to enter REPL. Use `--` to forward sqlite3 flags.",
  },
  args: {
    query: {
      type: "positional",
      required: false,
      description: "SQL string, '-' for stdin, or omit for the sqlite3 REPL",
    },
  },
  async run({ args }) {
    const queryArg = asString(args.query);
    const fromStdin = queryArg === "-";
    const inline = fromStdin ? null : (queryArg ?? null);
    // Reject `swrag sql "SQL" -- <args>`. Either form is fine on its own
    // — inline SQL, or SQL forwarded inside the `--` tail — but combining
    // them used to silently drop the inline SQL. Surface the conflict
    // rather than guess which one the user wanted.
    //
    // Note: we cannot rely on citty's `args.query` to tell us whether
    // the user supplied an inline positional, because citty doesn't
    // respect `--` and will happily pull a string out of the
    // passthrough tail and into `query`. We scan argv directly instead
    // — see `hasInlinePositionalBeforeDashDash`.
    if (PASSTHROUGH_ARGS.length > 0 && hasInlinePositionalBeforeDashDash("sql")) {
      error(
        "cannot combine inline SQL (or stdin) with `--` passthrough. " +
          "Put your SQL either before `--`, or inside the tail after `--` — not both.",
      );
      process.exit(2);
    }
    const sql = PASSTHROUGH_ARGS.length > 0 ? null : await readSqlInput(inline, fromStdin);
    const { paths } = ctx();
    const r = await runSql({
      sql,
      archive: paths.archive,
      sourceDb: paths.sourceDb,
      sourceDir: paths.sourceDir,
      embedModel: paths.embedModel,
      ollamaHost: paths.ollamaHost,
      extraArgs: [...PASSTHROUGH_ARGS],
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* index — Super Whisper ingestion                                            */
/* -------------------------------------------------------------------------- */

const indexCmd = defineCommand({
  meta: {
    name: "index",
    description: "Ingest changes from Super Whisper into the archive",
  },
  args: {},
  async run() {
    const { env, paths } = ctx();
    await runIndex({
      ...paths,
      skipEmbeddings: env.SWRAG_SKIP_EMBED,
    });
  },
});

/* -------------------------------------------------------------------------- */
/* doctor                                                                     */
/* -------------------------------------------------------------------------- */

const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "Verify your setup" },
  args: {},
  async run() {
    const r = await runDoctor(ctx().paths);
    process.stdout.write(r.output);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* bootstrap — one-shot post-install finisher                                 */
/* -------------------------------------------------------------------------- */

const bootstrapCmd = defineCommand({
  meta: {
    name: "bootstrap",
    description:
      "One-shot post-install: start ollama, pull the embed model, warm permissions, install the meeting watcher, index the archive, install the agent skill, and verify. Safe to re-run.",
  },
  args: {},
  async run() {
    const r = await runBootstrap(ctx().paths);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* path — print a filesystem path                                             */
/* -------------------------------------------------------------------------- */

const pathCmd = defineCommand({
  meta: {
    name: "path",
    description: "Print a path: archive (default), sqlite3, or vec0",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "archive | sqlite3 | vec0",
    },
  },
  run({ args }) {
    const target = PathTargetSchema.parse(asString(args.target) ?? "archive");
    process.stdout.write(`${getPath({ target, archive: ctx().paths.archive })}\n`);
  },
});

/* -------------------------------------------------------------------------- */
/* embed — print a vector as a SQL blob literal                               */
/* -------------------------------------------------------------------------- */

const embedCmd = defineCommand({
  meta: {
    name: "embed",
    description: "Emit a SQL blob literal (x'…') of the given text's embedding",
  },
  args: {
    text: { type: "positional", required: true, description: "Text to embed" },
  },
  async run({ args }) {
    const text = asString(args.text);
    if (!text) throw new Error("missing required positional: text");
    const { paths } = ctx();
    process.stdout.write(
      await runEmbed({
        text,
        embedModel: paths.embedModel,
        ollamaHost: paths.ollamaHost,
      }),
    );
  },
});

/* -------------------------------------------------------------------------- */
/* install-skill                                                              */
/* -------------------------------------------------------------------------- */

const installSkillCmd = defineCommand({
  meta: {
    name: "install-skill",
    description: "Install the manual-invocation SKILL.md to ~/.cursor and ~/.claude",
  },
  args: {},
  async run() {
    const results = await installSkill(ctx().paths.archive);
    for (const r of results) {
      process.stdout.write(`${r.action}: ${r.path}\n`);
    }
  },
});

/**
 * Resolve the binary path that the meeting watcher's launchd plists
 * should embed.
 *
 * We deliberately prefer Homebrew's stable symlink (`/opt/homebrew/bin/swrag`)
 * over the version-specific Cellar realpath. On `brew upgrade superwhisper-rag`
 * the new bottle lands at a fresh Cellar dir, the symlink is rewired
 * atomically, and `brew cleanup` deletes the old Cellar — which would
 * leave a launchd plist pointing at a deleted realpath. The symlink
 * survives upgrades, so the plist captured by `swrag meeting
 * enable-watcher` (or `swrag bootstrap`) keeps working across
 * versions without re-running the command.
 *
 * Resolution order:
 *   1. /opt/homebrew/bin/swrag                    (Apple Silicon brew)
 *   2. /usr/local/bin/swrag                       (Intel brew)
 *   3. realpath(process.execPath)                 (compiled binary outside brew)
 *
 * If none of those resolve we throw rather than write a plist that
 * points at a path which is known not to exist — the user would only
 * discover the breakage when launchd silently failed to start the
 * watcher.
 */
function resolveBinPath(): string {
  for (const p of ["/opt/homebrew/bin/swrag", "/usr/local/bin/swrag"]) {
    if (existsSync(p)) return p;
  }
  const execPath = process.execPath;
  if (execPath && !execPath.endsWith("/bun")) {
    try {
      return realpathSync(execPath);
    } catch {
      return execPath;
    }
  }
  throw new Error(
    "cannot resolve a stable swrag binary path for launchd. " +
      "Install via Homebrew (`brew install NikitaHerndlhofer/tap/superwhisper-rag`) " +
      "and re-run `swrag meeting enable-watcher`.",
  );
}

/* -------------------------------------------------------------------------- */
/* enqueue — add a wav to the meeting queue                                   */
/* -------------------------------------------------------------------------- */

const enqueueCmd = defineCommand({
  meta: {
    name: "enqueue",
    description:
      "Add a wav file to the meeting queue. Defaults captured_at to the file's mtime; records duration via afinfo.",
  },
  args: {
    path: {
      type: "positional",
      required: true,
      description: "Path to the wav file",
    },
    label: {
      type: "string",
      required: false,
      description: "Optional label stored with the queue row",
    },
    "captured-at": {
      type: "string",
      required: false,
      description: "ISO8601 capture timestamp (defaults to the wav's mtime)",
    },
  },
  async run({ args }) {
    const rawPath = asString(args.path);
    if (!rawPath) throw new Error("missing required positional: path");
    const absPath = resolvePath(rawPath);
    if (!existsSync(absPath)) {
      error(`file not found: ${absPath}`);
      process.exit(2);
    }
    const capturedAt = asString(args["captured-at"]) ?? statSync(absPath).mtime.toISOString();
    const label = asString(args.label) ?? null;
    const durationMs = await durationMsForWav(absPath);
    const { paths } = ctx();
    const db = openArchive(paths.archive, {});
    try {
      const row = meetingQueue.enqueue(db, {
        audio_path: absPath,
        captured_at: capturedAt,
        duration_ms: durationMs,
        label,
      });
      process.stdout.write(`enqueued id=${row.id} captured_at=${row.captured_at}\n`);
    } finally {
      db.close();
    }
  },
});

/* -------------------------------------------------------------------------- */
/* meeting queue (list/start/pause/state/discard)                             */
/* -------------------------------------------------------------------------- */

const queueListCmd = defineCommand({
  meta: { name: "list", description: "Print queue contents" },
  args: {
    status: {
      type: "string",
      required: false,
      description: "Filter: pending | transcribing | completed | failed | all (default)",
    },
  },
  async run({ args }) {
    const { paths } = ctx();
    const statusArg = asString(args.status) ?? "all";
    const status = parseListStatus(statusArg);
    // Daemon-route iff running. The daemon's response shape matches
    // the in-process queue.list() return type; we filter client-side
    // since `queue_list` is "all rows" without a status arg.
    const rows = await viaDaemonOrFallback(
      async () => {
        const r = await callDaemon<{ items: meetingQueue.MeetingQueueRow[] }>({
          op: "queue_list",
        });
        return r.items;
      },
      () => {
        const db = openArchive(paths.archive, {});
        try {
          return meetingQueue.list(db, { status: "all" });
        } finally {
          db.close();
        }
      },
    );
    const filtered = status === "all" ? rows : rows.filter((r) => r.status === status);
    if (filtered.length === 0) {
      process.stdout.write("(no rows)\n");
      return;
    }
    for (const r of filtered) {
      const dur = r.duration_ms == null ? "?" : `${(r.duration_ms / 1000).toFixed(1)}s`;
      const labelStr = r.label ? ` label=${r.label}` : "";
      const errStr = r.error ? ` error=${JSON.stringify(r.error)}` : "";
      const folderStr = r.sw_folder_name ? ` folder=${r.sw_folder_name}` : "";
      process.stdout.write(
        `${r.id}\t${r.status}\t${r.captured_at}\t${dur}${labelStr}${folderStr}${errStr}\n`,
      );
    }
  },
});

const queueStartCmd = defineCommand({
  meta: {
    name: "start",
    description:
      "Start draining the meeting queue. Routes through the daemon if running; blocks in-process otherwise.",
  },
  args: {},
  async run() {
    const { paths } = ctx();
    if (await isDaemonRunning()) {
      const r = await callDaemon<{ ok?: true; state?: string; batch_size?: number; error?: string }>(
        { op: "queue_start" },
      );
      if (r.error) {
        error(`queue start: ${r.error}`);
        process.exit(1);
      }
      info(`meeting queue: ${r.state ?? "?"} (batch_size=${r.batch_size ?? "?"})`);
      return;
    }
    const processor = buildProcessor(paths);
    await processor.recoverTranscribingRows();
    const stateBefore = readState(paths.archive);
    if (stateBefore === "processing") {
      info("meeting queue: already processing (in another process)");
    }
    await processor.start();
    const snap = processor.state();
    info(`meeting queue: ${snap.state}`);
  },
});

const queuePauseCmd = defineCommand({
  meta: {
    name: "pause",
    description:
      "Pause the queue processor. Routes through the daemon if running; flips persisted state otherwise.",
  },
  args: {},
  async run() {
    const { paths } = ctx();
    if (await isDaemonRunning()) {
      const r = await callDaemon<{ ok?: true; state?: string; error?: string }>({
        op: "queue_pause",
      });
      if (r.error) {
        error(`queue pause: ${r.error}`);
        process.exit(1);
      }
      info(`meeting queue: ${r.state ?? "?"}`);
      return;
    }
    const before = readState(paths.archive);
    if (before === "paused") {
      info("meeting queue: already paused");
      return;
    }
    if (before === "processing") {
      info("meeting queue: pausing; waiting for current item to finish...");
    }
    // Without a daemon to talk to, `pause()` invoked from a fresh
    // process only flips the persisted state. The actual loop running
    // in another process (or this one, if `start` is concurrent) reads
    // the flag at the top of each iteration. We still build a
    // processor instance for the consistent API surface.
    const processor = buildProcessor(paths);
    await processor.pause();
    info(`meeting queue: ${readState(paths.archive)}`);
  },
});

const queueStateCmd = defineCommand({
  meta: { name: "state", description: "Print current queue state (one line)." },
  args: {},
  async run() {
    const { paths } = ctx();
    if (await isDaemonRunning()) {
      const snap = await callDaemon<{
        state: string;
        current_item: { id: number } | null;
        batch_position: number | null;
        batch_size: number | null;
      }>({ op: "queue_state" });
      const status = await callDaemon<{ queue_pending: number }>({ op: "status" });
      const cur = snap.current_item?.id != null ? ` current=${snap.current_item.id}` : "";
      process.stdout.write(
        `${snap.state} pending=${status.queue_pending}${cur} batch=${snap.batch_position ?? 0}/${snap.batch_size ?? 0}\n`,
      );
      return;
    }
    const state = readState(paths.archive);
    const db = openArchive(paths.archive, {});
    let pending: number;
    try {
      pending = meetingQueue.countPending(db);
    } finally {
      db.close();
    }
    process.stdout.write(`${state} pending=${pending}\n`);
  },
});

const queueDiscardCmd = defineCommand({
  meta: { name: "discard", description: "Mark a queued row as discarded; deletes the wav." },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Queue row id",
    },
  },
  async run({ args }) {
    const raw = asString(args.id);
    const id = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(id)) {
      error(`invalid id: ${raw}`);
      process.exit(2);
    }
    const { paths } = ctx();
    if (await isDaemonRunning()) {
      const r = await callDaemon<{ ok?: true; error?: string }>({
        op: "queue_discard",
        id,
      });
      if (r.error) {
        error(`discard failed: ${r.error}`);
        process.exit(1);
      }
      info(`discarded id=${id}`);
      return;
    }
    const processor = buildProcessor(paths);
    const result = processor.discard(id);
    if (!result.ok) {
      error(`discard failed: ${result.reason ?? "unknown"}`);
      process.exit(1);
    }
    info(`discarded id=${id}`);
  },
});

const queueGroupCmd = defineCommand({
  meta: { name: "queue", description: "Manage the meeting queue" },
  subCommands: {
    list: queueListCmd,
    start: queueStartCmd,
    pause: queuePauseCmd,
    state: queueStateCmd,
    discard: queueDiscardCmd,
  },
});

/* -------------------------------------------------------------------------- */
/* meeting status / permissions-check                                         */
/* -------------------------------------------------------------------------- */

/**
 * One-shot meeting probe. Spawns `swrag-helper events` briefly,
 * captures the snapshot plus ~200 ms of follow-up events, feeds them
 * through the detector, prints the resulting `MeetingSignal` as
 * pretty JSON.
 *
 * Hard 1 s ceiling on the helper wait — if no snapshot arrives, we
 * bail with a clear error rather than hanging.
 */
const meetingStatusCmd = defineCommand({
  meta: {
    name: "status",
    description:
      "Probe current meeting state. Routes through the daemon if running; otherwise spawns a one-shot helper.",
  },
  args: {},
  async run() {
    if (await isDaemonRunning()) {
      const r = await callDaemon<object>({ op: "status" });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return;
    }
    const handle = spawnEventsHelper();
    const detector = new MeetingDetector();
    let sawSnapshot = false;
    let postSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    const done: Promise<void> = new Promise<void>((resolve) => {
      overallTimer = setTimeout(resolve, 1_000);
      void (async () => {
        try {
          for await (const ev of handle.events) {
            await detector.handleEvent(ev);
            if (ev.event === "snapshot" && !sawSnapshot) {
              sawSnapshot = true;
              // Give the helper 200 ms to surface any immediate
              // follow-up mic_changed / frontmost_changed before we
              // commit to a signal.
              postSnapshotTimer = setTimeout(resolve, 200);
            }
          }
        } catch {
          // Iterator errored (helper crashed or invalid line) — let
          // the overall timer handle resolution; we have whatever
          // state the detector accumulated up to here.
        } finally {
          resolve();
        }
      })();
    });
    await done;
    if (postSnapshotTimer) clearTimeout(postSnapshotTimer);
    if (overallTimer) clearTimeout(overallTimer);
    await handle.stop();
    if (!sawSnapshot) {
      // Surface any stderr the helper emitted before dying. Without
      // this the only visible failure is "did not emit a snapshot",
      // which makes a Swift-side crash impossible to diagnose.
      const tail = handle.stderrTail();
      const suffix = tail.length > 0 ? `: ${tail}` : "";
      error(`meeting status: helper did not emit a snapshot within 1 s${suffix}`);
      detector.dispose();
      process.exit(1);
    }
    const signal = detector.signal();
    detector.dispose();
    process.stdout.write(`${JSON.stringify(signal, null, 2)}\n`);
  },
});

const meetingPermissionsCmd = defineCommand({
  meta: {
    name: "permissions-check",
    description:
      "Probe macOS permissions: microphone, screen recording, and Apple Events per browser. Pass --prompt to fire system dialogs.",
  },
  args: {
    prompt: {
      type: "boolean",
      required: false,
      description: "Fire the macOS permission dialogs for any not-determined items.",
    },
  },
  async run({ args }) {
    // citty's boolean flag parser hands us `true | false | undefined` (or
    // a literal `"true"` string when the user wrote `--prompt=true` on
    // the command line). Normalise both shapes.
    const promptRaw: unknown = args.prompt;
    const prompt = promptRaw === true || promptRaw === "true";
    const perms = await getPermissions({ prompt });
    process.stdout.write(`${JSON.stringify(perms, null, 2)}\n`);
  },
});

/* -------------------------------------------------------------------------- */
/* meeting record (start/stop)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Config key under which we persist the user's one-time legal
 * acknowledgement that they accept responsibility for call-recording
 * compliance when enabling system-audio capture. Value `"1"` means
 * acknowledged; absence (or anything else) means not acknowledged yet.
 */
const SYSTEM_AUDIO_ACK_CONFIG_KEY = "meeting_system_audio_ack";

const SYSTEM_AUDIO_LEGAL_TEXT = `You're enabling system audio capture, which records audio output from other
applications (including other participants in calls).

You are solely responsible for complying with applicable laws on call
recording (two-party-consent jurisdictions, GDPR, etc.). swrag does NOT
notify other call participants.

To acknowledge and continue: pass --ack-legal once.`;

function isSystemAudioAcked(archive: string): boolean {
  const db = openArchive(archive, {});
  try {
    return getConfig(db, SYSTEM_AUDIO_ACK_CONFIG_KEY) === "1";
  } finally {
    db.close();
  }
}

function setSystemAudioAcked(archive: string): void {
  const db = openArchive(archive, {});
  try {
    setConfig(db, SYSTEM_AUDIO_ACK_CONFIG_KEY, "1");
  } finally {
    db.close();
  }
}

const meetingRecordStartCmd = defineCommand({
  meta: {
    name: "start",
    description:
      "Start recording. Routes through the daemon if running (returns immediately); foreground otherwise (Ctrl-C to stop and save).",
  },
  args: {
    label: {
      type: "string",
      required: false,
      description: "Optional label stored with the queue row.",
    },
    "system-audio": {
      type: "boolean",
      required: false,
      description:
        "Also capture system audio output via ScreenCaptureKit. Opt-in for legal reasons.",
    },
    "ack-legal": {
      type: "boolean",
      required: false,
      description:
        "Acknowledge the legal warning for system-audio capture (one-time, persisted).",
    },
  },
  async run({ args }) {
    const label = asString(args.label);
    const captureSystemAudio = args["system-audio"] === true;
    const ackLegal = args["ack-legal"] === true;
    const { paths } = ctx();

    if (captureSystemAudio) {
      if (ackLegal) setSystemAudioAcked(paths.archive);
      if (!isSystemAudioAcked(paths.archive)) {
        process.stderr.write(`${SYSTEM_AUDIO_LEGAL_TEXT}\n`);
        process.exit(2);
      }
    }

    // Daemon-route iff running. The daemon owns recorder lifecycle
    // when it's up — `record start` becomes a fire-and-forget op,
    // matching the Phase 4 spec.
    if (await isDaemonRunning()) {
      const op: { op: "record_start"; label?: string; system_audio?: boolean } = {
        op: "record_start",
      };
      if (label) op.label = label;
      if (captureSystemAudio) op.system_audio = true;
      const r = await callDaemon<{
        ok?: true;
        audio_path?: string;
        error?: string;
      }>(op);
      if (r.error === "already_recording") {
        info(`meeting record: already recording (path=${r.audio_path ?? "?"})`);
        return; // Exit 0 — idempotent per the plan.
      }
      if (r.error) {
        error(`record start failed via daemon: ${r.error}`);
        process.exit(1);
      }
      info(`recording started via daemon → ${r.audio_path ?? "?"}`);
      return;
    }

    info(
      `recording starting${label ? ` (label=${label})` : ""}${
        captureSystemAudio ? " [+system-audio]" : ""
      }`,
    );

    let handle: RecordingHandle;
    try {
      handle = await startRecording(
        { label, captureSystemAudio },
        { archive: paths.archive },
      );
    } catch (e) {
      error(`recorder start failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }

    info(`recording → ${handle.audioPath}`);

    // Heartbeat passthrough on stderr — keeps the foreground experience
    // self-explanatory (the user sees the duration tick up as they
    // record). Errors swallowed because the iterator is cancelled at
    // shutdown via spawnRecorder.stop().
    const pumpHeartbeats = async (): Promise<void> => {
      try {
        for await (const hb of handle.recorder.events) {
          const seconds = (hb.duration_ms / 1000).toFixed(1);
          const dbfs = Number.isFinite(hb.level_dbfs) ? hb.level_dbfs.toFixed(1) : "-inf";
          info(`recording: ${seconds}s, ${dbfs} dBFS`);
        }
      } catch {
        // iterator closed — expected on stop
      }
    };
    const pumpPromise = pumpHeartbeats();

    // Install SIGINT/SIGTERM handlers BEFORE awaiting anything else.
    // The handler closure must be idempotent because Node delivers
    // SIGINT to every listener and we attach to both.
    let stopping = false;
    const finalise = async (signal: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      info(`recording: received ${signal}, finalising...`);
      try {
        const result = await stopRecording(handle, { discard: false }, { archive: paths.archive });
        if (result.queueRow) {
          const seconds = (result.durationMs / 1000).toFixed(1);
          info(
            `recording stopped: queue id=${result.queueRow.id} duration=${seconds}s path=${result.audioPath}`,
          );
        } else {
          info("recording stopped (no queue row)");
        }
      } catch (e) {
        error(`recorder stop failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      try {
        await pumpPromise;
      } catch {
        // best-effort
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void finalise("SIGINT"));
    process.on("SIGTERM", () => void finalise("SIGTERM"));

    // Block forever — the signal handler is the only legitimate exit.
    // Without this the function would return and the process would
    // exit before any audio was captured.
    await new Promise<void>(() => {
      // intentionally never resolves
    });
  },
});

const meetingRecordStopCmd = defineCommand({
  meta: {
    name: "stop",
    description:
      "Stop the daemon's current recording. With --discard, drops the wav instead of enqueueing.",
  },
  args: {
    discard: {
      type: "boolean",
      required: false,
      description: "Discard the wav instead of enqueueing it.",
    },
  },
  async run({ args }) {
    if (!(await isDaemonRunning())) {
      process.stderr.write(
        "meeting record stop: daemon is not running. " +
          "If you started recording via `swrag meeting record start` without the daemon, Ctrl-C that foreground session to stop.\n",
      );
      process.exit(2);
    }
    const discard = args.discard === true;
    const r = await callDaemon<{ ok?: true; error?: string }>({
      op: "record_stop",
      discard,
    });
    if (r.error === "not_recording") {
      info("meeting record stop: no active recording");
      return; // idempotent
    }
    if (r.error) {
      error(`record stop failed via daemon: ${r.error}`);
      process.exit(1);
    }
    info(discard ? "recording discarded" : "recording saved");
  },
});

const meetingRecordGroupCmd = defineCommand({
  meta: { name: "record", description: "Capture meeting audio (mic + optional system audio)" },
  subCommands: {
    start: meetingRecordStartCmd,
    stop: meetingRecordStopCmd,
  },
});

/* -------------------------------------------------------------------------- */
/* meeting watch / menubar / enable-watcher / disable-watcher                 */
/* -------------------------------------------------------------------------- */

const meetingWatchCmd = defineCommand({
  meta: {
    name: "watch",
    description: "Run the meeting capture daemon in the foreground (used by launchd).",
  },
  args: {},
  async run() {
    const { paths } = ctx();
    const env = getEnv();
    await runDaemonForeground({
      archive: paths.archive,
      sourceDir: paths.sourceDir,
      sourceDb: paths.sourceDb,
      swDbPath: paths.sourceDb,
      swRecordingsDir: `${paths.sourceDir}/recordings`,
      embedModel: paths.embedModel,
      ollamaHost: paths.ollamaHost,
      keepAudio: env.SWRAG_KEEP_QUEUE_AUDIO,
    });
  },
});

const meetingMenubarCmd = defineCommand({
  meta: {
    name: "menubar",
    description: "Run the Swift menu bar app (subscribes to the daemon over the unix socket).",
  },
  args: {},
  async run() {
    // The Swift helper has a `menubar` subcommand that connects to
    // the daemon's socket and renders an NSStatusItem. We inherit
    // stdio so the user sees any Swift-side diagnostics in their
    // shell during dev; launchd routes both to the log path.
    const bin = helperBinaryPath();
    const proc = Bun.spawn([bin, "menubar"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  },
});

const meetingEnableWatcherCmd = defineCommand({
  meta: {
    name: "enable-watcher",
    description:
      "Install the daemon + menubar launchd agents. With --system-audio, also persists the legal ack.",
  },
  args: {
    "system-audio": {
      type: "boolean",
      required: false,
      description: "Default to capturing system audio for daemon-driven recordings (implies legal ack).",
    },
  },
  async run({ args }) {
    const systemAudio = args["system-audio"] === true;
    const { paths } = ctx();
    try {
      const r = await enableWatcher({
        binPath: resolveBinPath(),
        archive: paths.archive,
        systemAudio,
      });
      info(`meeting watcher installed: watch=${r.watchPlist}, menubar=${r.menubarPlist}`);
      if (r.systemAudioPersisted) {
        info("meeting watcher: system-audio default enabled (and legal ack persisted)");
      }
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  },
});

const meetingDisableWatcherCmd = defineCommand({
  meta: { name: "disable-watcher", description: "Remove the daemon + menubar launchd agents." },
  args: {},
  async run() {
    const r = await disableWatcher();
    const parts: string[] = [];
    parts.push(r.watchRemoved ? "watch removed" : "watch not installed");
    parts.push(r.menubarRemoved ? "menubar removed" : "menubar not installed");
    info(`meeting watcher: ${parts.join("; ")}`);
  },
});

const meetingCmd = defineCommand({
  meta: { name: "meeting", description: "Meeting capture pipeline commands" },
  subCommands: {
    queue: queueGroupCmd,
    status: meetingStatusCmd,
    "permissions-check": meetingPermissionsCmd,
    record: meetingRecordGroupCmd,
    watch: meetingWatchCmd,
    menubar: meetingMenubarCmd,
    "enable-watcher": meetingEnableWatcherCmd,
    "disable-watcher": meetingDisableWatcherCmd,
  },
});

function parseListStatus(s: string): meetingQueue.MeetingQueueStatus | "all" {
  if (s === "all") return "all";
  const parsed = meetingQueue.MeetingQueueStatusSchema.safeParse(s);
  if (!parsed.success) {
    error(`invalid status: ${s}. Expected one of: pending, transcribing, completed, failed, all.`);
    process.exit(2);
  }
  return parsed.data;
}

function buildProcessor(paths: ResolvedPaths): MeetingProcessor {
  const env = getEnv();
  return new MeetingProcessor({
    archive: paths.archive,
    sourceDir: paths.sourceDir,
    sourceDb: paths.sourceDb,
    swDbPath: paths.sourceDb,
    swRecordingsDir: `${paths.sourceDir}/recordings`,
    embedModel: paths.embedModel,
    ollamaHost: paths.ollamaHost,
    keepAudio: env.SWRAG_KEEP_QUEUE_AUDIO,
  });
}

/**
 * `afinfo` is part of macOS's CoreAudio toolset and reports duration
 * for any wav/m4a/aiff. Stderr is silenced. Returns null if afinfo is
 * unavailable or the output doesn't parse (we still enqueue the row;
 * downstream code falls back to an unbounded `waitForCompletion`).
 */
async function durationMsForWav(path: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["afinfo", path], { stdout: "pipe", stderr: "pipe" });
    const out = await Bun.readableStreamToText(proc.stdout);
    const exit = await proc.exited;
    if (exit !== 0) return null;
    const m = out.match(/estimated duration:\s*([0-9.]+)\s*sec/i);
    const captured = m?.[1];
    if (!captured) return null;
    const seconds = Number.parseFloat(captured);
    if (!Number.isFinite(seconds)) return null;
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const main = defineCommand({
  meta: {
    name: "swrag",
    version: VERSION,
    description:
      "Thin sqlite3 wrapper for your Super Whisper dictation archive. Adds a sync ingester and an embed() shortcut.",
  },
  subCommands: {
    sql: sqlCmd,
    index: indexCmd,
    doctor: doctorCmd,
    bootstrap: bootstrapCmd,
    path: pathCmd,
    embed: embedCmd,
    "install-skill": installSkillCmd,
    enqueue: enqueueCmd,
    meeting: meetingCmd,
  },
});

runMain(main).catch((e: unknown) => {
  error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
