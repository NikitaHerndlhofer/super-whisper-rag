/**
 * Meeting capture daemon.
 *
 * Phase 4's headline component. The daemon ties together every other
 * Phase 1–3 module:
 *
 *   - Phase 1 processor: drains the meeting_queue FIFO and patches SW.
 *     Reachable via `queue_start` / `queue_pause` / `queue_state` /
 *     `queue_list` / `queue_discard` socket ops.
 *   - Phase 2 detector: consumes the events-helper stdout pipe and
 *     emits MeetingEdge transitions. NONE → HIGH triggers the start
 *     popup; HIGH → NONE while recording triggers the auto-stop with
 *     a 5 s undo window.
 *   - Phase 3 recorder: spawned on `record_start`; SIGTERMed on
 *     `record_stop` or auto-stop. The recorder's own SIGPIPE-resilience
 *     means if the daemon dies the wav still flushes cleanly.
 *
 * Surface: a unix socket at
 * `~/Library/Application Support/superwhisper-rag/meeting.sock` with
 * mode 0600, speaking line-delimited JSON. Two interaction patterns:
 *
 *   1. Request / response — open, send one op, read one response,
 *      close. Used by the CLI's daemon-client and by the menubar's
 *      one-shot ops.
 *   2. Subscription — open, send `subscribe`, keep open, receive
 *      pushed events as they happen. Used by the menubar to drive
 *      its UI without polling.
 *
 * Lifecycle:
 *
 *   - On start: scan for orphan wavs in `incoming/` (recover ones
 *     older than 10 minutes, quarantine fresher ones), reconcile
 *     `transcribing` queue rows against SW's DB (Phase 1's
 *     `recoverTranscribingRows`), resume the processor if its
 *     persisted state was `processing`.
 *   - Runtime: events helper supervised with 1 s → 5 s → 30 s
 *     backoff; recorder owned by the daemon (only one ever exists);
 *     the processor's pause/start state is the persisted config
 *     key — concurrent CLI invocations see the same state.
 *   - On stop (SIGTERM): pause the processor + wait up to 30 s for
 *     the current item to finalise, SIGTERM the events helper +
 *     await drain, save any in-flight recording (don't lose data),
 *     push `{"event":"shutdown"}` to subscribers, unlink the socket,
 *     exit 0.
 *
 * The daemon is also designed to be in-process testable: every
 * cross-process side-effect (events helper, recorder, popup,
 * processor hooks) is injectable. Tests spin up a daemon, dial the
 * socket via `Bun.connect`, and exercise the protocol end-to-end
 * without touching any real OS process beyond bun:sqlite.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getConfig, openArchive } from "../archive/open.ts";
import { error, info, verbose, warn } from "../log.ts";
import {
  type EventLine,
  type EventsHandle,
  spawnEventsHelper,
  type SpawnEventsOptions,
} from "../mac/helper.ts";
import { defaultConfig, type PopupConfig, readConfig } from "./config.ts";
import { decidePopup } from "./decide-popup.ts";
import { type MeetingEdge, MeetingDetector } from "./detect.ts";
import {
  MeetingProcessor,
  MEETING_QUEUE_STATE_KEY,
  type ProcessorHooks,
  type ProcessorOptions,
  readState,
} from "./processor.ts";
import * as queue from "./queue.ts";
import {
  askStartRecording as defaultAskStartRecording,
  type ExecFn,
  notifyAutoStopped as defaultNotifyAutoStopped,
} from "./popup.ts";
import {
  type RecordingHandle,
  type RecordDeps,
  startRecording as defaultStartRecording,
  type StartRecordingOptions,
  stopRecording as defaultStopRecording,
  type StoppedRecording,
  DEFAULT_MEETINGS_INCOMING_DIR,
} from "./record.ts";

/* -------------------------------------------------------------------------- */
/* Constants & paths                                                          */
/* -------------------------------------------------------------------------- */

export const DEFAULT_DAEMON_SOCKET_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "superwhisper-rag",
  "meeting.sock",
);

export const DEFAULT_QUARANTINE_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "superwhisper-rag",
  "meetings",
  "quarantine",
);

const ORPHAN_RECOVERY_MIN_AGE_MS = 10 * 60 * 1000;
const UNDO_WINDOW_MS = 5_000;
const POPUP_GIVE_UP_SEC = 90;
const SHUTDOWN_PROCESSOR_WAIT_MS = 30_000;
const EVENTS_HELPER_BACKOFF_MS = [1_000, 5_000, 30_000] as const;

/** Config keys consumed by the daemon. */
export const CONFIG_SYSTEM_AUDIO_DEFAULT = "meeting_system_audio_default";
export const CONFIG_SYSTEM_AUDIO_ACK = "meeting_system_audio_ack";

/* -------------------------------------------------------------------------- */
/* Op + event schemas                                                         */
/* -------------------------------------------------------------------------- */

/** Discriminated request union. Every wire-shaped object validated here. */
export const SocketRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }),
  z.object({
    op: z.literal("record_start"),
    label: z.string().optional(),
    system_audio: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("record_stop"),
    discard: z.boolean().optional(),
  }),
  z.object({ op: z.literal("undo_last") }),
  z.object({ op: z.literal("queue_list") }),
  z.object({ op: z.literal("queue_state") }),
  z.object({ op: z.literal("queue_start") }),
  z.object({ op: z.literal("queue_pause") }),
  z.object({ op: z.literal("queue_discard"), id: z.number().int() }),
  z.object({ op: z.literal("subscribe") }),
  z.object({ op: z.literal("config_reload") }),
]);
export type SocketRequest = z.infer<typeof SocketRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Daemon options                                                             */
/* -------------------------------------------------------------------------- */

export interface DaemonDeps {
  /** Replace `spawnEventsHelper` with a stub (tests inject canned streams). */
  spawnEventsHelper?: (opts?: SpawnEventsOptions) => EventsHandle;
  startRecording?: (
    opts: StartRecordingOptions,
    deps: RecordDeps,
  ) => Promise<RecordingHandle>;
  stopRecording?: (
    handle: RecordingHandle,
    opts: { discard: boolean },
    deps: RecordDeps,
  ) => Promise<StoppedRecording>;
  /** Replace osascript popup (tests pass a recording stub). */
  askStartRecording?: typeof defaultAskStartRecording;
  /** Replace osascript notification. */
  notifyAutoStopped?: typeof defaultNotifyAutoStopped;
  /** Override the shared exec used by popup defaults. */
  popupExec?: ExecFn;
}

export interface DaemonOptions {
  /** Paths the daemon needs to operate. Same shape `MeetingProcessor` wants. */
  archive: string;
  sourceDir: string;
  sourceDb: string;
  swDbPath: string;
  swRecordingsDir: string;
  embedModel: string;
  ollamaHost: string;
  keepAudio?: boolean;
  /** Override the socket path (test fixture / non-standard install). */
  socketPath?: string;
  /** Override the incoming wav dir (default: ~/Library/.../meetings/incoming). */
  incomingDir?: string;
  /** Override the quarantine wav dir. */
  quarantineDir?: string;
  /** Disable detector wiring (record-only daemon for tests / niche use). */
  disableDetection?: boolean;
  /** Use the supplied processor hooks; otherwise the processor runs real ops. */
  processorHooks?: ProcessorHooks;
  /** Recording dependencies override. */
  deps?: DaemonDeps;
  /** Override the events helper backoff schedule (tests run fast). */
  eventsBackoffMs?: readonly number[];
  /** Override the undo window in ms (tests use short values). */
  undoWindowMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Internal state types                                                       */
/* -------------------------------------------------------------------------- */

interface RecordingState {
  handle: RecordingHandle;
  since: string; // ISO
  label: string | null;
  captureSystemAudio: boolean;
}

interface UndoState {
  /** Queue row id that was just auto-stopped. */
  queueRowId: number;
  /** Absolute wav path so we can unlink on undo. */
  wavPath: string;
  /** When the undo window expires (epoch ms). */
  until: number;
  /** Timer that clears the undo window once `until` passes. */
  timer: ReturnType<typeof setTimeout>;
}

interface ConnectionState {
  /** Partial line buffer for stream framing. */
  buffer: string;
  /** True once the connection has sent `subscribe`. */
  isSubscriber: boolean;
}

/* -------------------------------------------------------------------------- */
/* MeetingDaemon                                                              */
/* -------------------------------------------------------------------------- */

type SocketHandle = {
  write: (data: string) => number;
  end: (data?: string) => void;
  data: ConnectionState | null;
};

type SocketListener = {
  stop: (forceClose?: boolean) => Promise<void> | void;
};

export class MeetingDaemon {
  private readonly opts: DaemonOptions;
  private readonly socketPath: string;
  private readonly incomingDir: string;
  private readonly quarantineDir: string;
  private readonly deps: Required<
    Pick<DaemonDeps, "spawnEventsHelper" | "startRecording" | "stopRecording">
  > &
    Pick<DaemonDeps, "askStartRecording" | "notifyAutoStopped" | "popupExec">;
  private readonly undoWindowMs: number;
  private readonly eventsBackoffMs: readonly number[];

  private processor: MeetingProcessor;
  private detector: MeetingDetector | null = null;
  private eventsHandle: EventsHandle | null = null;
  private eventsConsumerPromise: Promise<void> | null = null;
  private eventsRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private eventsRestartFailures = 0;

  private recording: RecordingState | null = null;
  private undo: UndoState | null = null;

  private listener: SocketListener | null = null;
  private subscribers: Set<SocketHandle> = new Set();
  private connections: Set<SocketHandle> = new Set();
  private lastEdgeSignal: MeetingEdge["signal"] | null = null;

  /**
   * In-memory snapshot of the user's popup config. Loaded at
   * `start()` and replaced on `config_reload`. Stored on the
   * instance so the detection edge handler doesn't have to hit
   * the DB on every edge — popups are decided against the
   * cached value, and a CLI write must explicitly fire
   * `config_reload` (the CLI does this for us) to take effect
   * in-process.
   */
  private popupConfig: PopupConfig = defaultConfig();

  private stopping = false;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.socketPath = opts.socketPath ?? DEFAULT_DAEMON_SOCKET_PATH;
    this.incomingDir = opts.incomingDir ?? DEFAULT_MEETINGS_INCOMING_DIR;
    this.quarantineDir = opts.quarantineDir ?? DEFAULT_QUARANTINE_DIR;
    this.deps = {
      spawnEventsHelper: opts.deps?.spawnEventsHelper ?? spawnEventsHelper,
      startRecording: opts.deps?.startRecording ?? defaultStartRecording,
      stopRecording: opts.deps?.stopRecording ?? defaultStopRecording,
      askStartRecording: opts.deps?.askStartRecording,
      notifyAutoStopped: opts.deps?.notifyAutoStopped,
      popupExec: opts.deps?.popupExec,
    };
    this.undoWindowMs = opts.undoWindowMs ?? UNDO_WINDOW_MS;
    this.eventsBackoffMs = opts.eventsBackoffMs ?? EVENTS_HELPER_BACKOFF_MS;
    this.processor = new MeetingProcessor(this.buildProcessorOptions());
  }

  /* ---------------------------- start / stop ----------------------------- */

  /**
   * Bring the daemon up: orphan-wav scan, transcribing-row recovery,
   * persisted-state resume, events-helper spawn, socket bind.
   *
   * Idempotent only at process scope — calling start() twice in one
   * process throws because we'd double-bind the socket.
   */
  async start(): Promise<void> {
    if (this.listener) {
      throw new Error("daemon already started");
    }
    mkdirSync(this.incomingDir, { recursive: true });
    mkdirSync(this.quarantineDir, { recursive: true });
    mkdirSync(dirname(this.socketPath), { recursive: true });

    this.loadPopupConfig();

    await this.scanOrphanWavs();
    await this.processor.recoverTranscribingRows();
    await this.maybeResumeProcessor();

    if (!this.opts.disableDetection) {
      this.detector = new MeetingDetector({
        onEdge: (edge) => {
          // Async-fire detection actions; await isn't required because
          // each handler is independent.
          void this.onDetectionEdge(edge);
        },
      });
      this.startEventsHelper();
    }

    await this.bindSocket();
    info(`meeting daemon: listening on ${this.socketPath}`);
  }

  /**
   * Graceful shutdown. Pauses the processor (with a 30 s ceiling),
   * stops the events helper, finalises any in-flight recording into
   * the queue (we save, never discard, to honour the "don't lose
   * data" contract), pushes `{"event":"shutdown"}` to subscribers,
   * unlinks the socket, returns.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    info("meeting daemon: stopping");

    // 1. Pause processor + bounded wait so a slow current item
    //    doesn't hold up shutdown indefinitely.
    try {
      await Promise.race([this.processor.pause(), sleep(SHUTDOWN_PROCESSOR_WAIT_MS)]);
    } catch (e) {
      warn(`meeting daemon: processor pause failed: ${errMsg(e)}`);
    }

    // 2. Stop events helper (cancel any pending restart timer first).
    if (this.eventsRestartTimer) {
      clearTimeout(this.eventsRestartTimer);
      this.eventsRestartTimer = null;
    }
    if (this.eventsHandle) {
      try {
        await this.eventsHandle.stop();
      } catch (e) {
        warn(`meeting daemon: events helper stop failed: ${errMsg(e)}`);
      }
      this.eventsHandle = null;
    }
    if (this.eventsConsumerPromise) {
      try {
        await Promise.race([this.eventsConsumerPromise, sleep(2_000)]);
      } catch {
        // best-effort
      }
      this.eventsConsumerPromise = null;
    }
    this.detector?.dispose();
    this.detector = null;

    // 3. In-flight recording → save, don't discard. Same code path the
    //    auto-stop uses minus the notification / undo plumbing.
    if (this.recording) {
      try {
        await this.deps.stopRecording(
          this.recording.handle,
          { discard: false },
          { archive: this.opts.archive, incomingDir: this.incomingDir },
        );
      } catch (e) {
        warn(`meeting daemon: recorder stop on shutdown failed: ${errMsg(e)}`);
      }
      this.recording = null;
    }

    // 4. Clear undo state.
    if (this.undo) {
      clearTimeout(this.undo.timer);
      this.undo = null;
    }

    // 5. Push shutdown to every subscriber, then close.
    const shutdownLine = `${JSON.stringify({ event: "shutdown" })}\n`;
    for (const sub of this.subscribers) {
      try {
        sub.write(shutdownLine);
        sub.end();
      } catch {
        // already closed
      }
    }
    this.subscribers.clear();
    for (const conn of this.connections) {
      try {
        conn.end();
      } catch {
        // already closed
      }
    }
    this.connections.clear();

    // 6. Stop listening + unlink the socket file.
    if (this.listener) {
      try {
        await this.listener.stop(true);
      } catch (e) {
        warn(`meeting daemon: listener stop failed: ${errMsg(e)}`);
      }
      this.listener = null;
    }
    try {
      if (existsSync(this.socketPath)) await unlink(this.socketPath);
    } catch (e) {
      verbose(`meeting daemon: socket unlink failed: ${errMsg(e)}`);
    }
    info("meeting daemon: stopped");
  }

  /* ----------------------------- detection ------------------------------- */

  /**
   * Detection edge handler. NONE → HIGH (or → MEDIUM, when the
   * user configured `threshold=MEDIUM`) fires the start popup if
   * we aren't already recording; HIGH → NONE while recording
   * fires the auto-stop with notification + 5 s undo window. Both
   * paths push `detect_changed` to subscribers.
   *
   * The popup gate is now configurable via `decidePopup`:
   * allow/blocklists, schedule windows, and a confidence threshold
   * all funnel through that one pure function. The detector itself
   * only cares about HIGH/MEDIUM/NONE edges; everything user-facing
   * lives in the config.
   */
  private async onDetectionEdge(edge: MeetingEdge): Promise<void> {
    this.lastEdgeSignal = edge.signal;
    this.pushEvent({
      event: "detect_changed",
      confidence: edge.signal.confidence,
      reason: edge.signal.reason,
      evidence: edge.signal.evidence,
    });
    // Popup gate: any edge INTO a non-NONE state may fire a popup.
    // The decision function filters out NONE itself, plus everything
    // gated by config. We still only ever fire when we aren't
    // already mid-recording.
    if (edge.from === "NONE" && edge.to !== "NONE" && !this.recording) {
      // Don't block the detector tick on the popup; run it on the
      // microtask queue.
      void this.firePopupForEdge(edge);
    } else if (edge.to === "NONE" && this.recording) {
      await this.fireAutoStopForEdge();
    }
  }

  private async firePopupForEdge(edge: MeetingEdge): Promise<void> {
    const decision = decidePopup(edge.signal, this.popupConfig, new Date());
    if (!decision.fire) {
      info(`meeting daemon: popup suppressed (${decision.reason})`);
      return;
    }
    verbose(`meeting daemon: popup fire decision: ${decision.reason}`);
    const ask = this.deps.askStartRecording ?? defaultAskStartRecording;
    let choice: "record" | "skip" | "timeout";
    try {
      choice = await ask({
        reason: `Meeting detected: ${edge.signal.reason}.`,
        giveUpAfterSec: POPUP_GIVE_UP_SEC,
        exec: this.deps.popupExec,
      });
    } catch (e) {
      warn(`meeting daemon: popup failed: ${errMsg(e)}`);
      return;
    }
    if (choice !== "record") {
      info(`meeting daemon: popup → ${choice}; not starting recording`);
      return;
    }
    // The user opted in via the popup. Use the configured
    // system-audio default; consent ack required for the on case.
    const def = this.systemAudioDefault();
    if (def && !this.systemAudioAcked()) {
      warn(
        "meeting daemon: meeting_system_audio_default=1 but ack missing; recording mic-only",
      );
    }
    const captureSystemAudio = def && this.systemAudioAcked();
    try {
      await this.handleRecordStart({
        label: null,
        captureSystemAudio,
        source: "popup",
      });
    } catch (e) {
      warn(`meeting daemon: popup-driven record_start failed: ${errMsg(e)}`);
    }
  }

  private async fireAutoStopForEdge(): Promise<void> {
    if (!this.recording) return;
    const rec = this.recording;
    let stopped: StoppedRecording;
    try {
      stopped = await this.deps.stopRecording(
        rec.handle,
        { discard: false },
        { archive: this.opts.archive, incomingDir: this.incomingDir },
      );
    } catch (e) {
      warn(`meeting daemon: auto-stop failed: ${errMsg(e)}`);
      this.recording = null;
      this.pushEvent({ event: "status_changed", reason: "auto_stop_failed" });
      return;
    }
    this.recording = null;
    if (stopped.queueRow) {
      this.openUndoWindow(stopped.queueRow.id, stopped.audioPath ?? rec.handle.audioPath);
      const notify = this.deps.notifyAutoStopped ?? defaultNotifyAutoStopped;
      try {
        await notify({
          wavPath: rec.handle.audioPath,
          queueRowId: stopped.queueRow.id,
          exec: this.deps.popupExec,
        });
      } catch (e) {
        verbose(`meeting daemon: notification failed: ${errMsg(e)}`);
      }
      this.pushEvent({ event: "queue_changed", reason: "auto_stop" });
    }
    this.pushEvent({ event: "status_changed", reason: "auto_stopped" });
  }

  /* ----------------------------- socket I/O ------------------------------ */

  private async bindSocket(): Promise<void> {
    // Stale socket cleanup — if a previous daemon crashed without
    // unlinking, Bun.listen would refuse to bind. We unlink eagerly;
    // file ops on a missing file are no-ops via the existsSync guard.
    if (existsSync(this.socketPath)) {
      try {
        await unlink(this.socketPath);
      } catch (e) {
        warn(`meeting daemon: failed to unlink stale socket ${this.socketPath}: ${errMsg(e)}`);
      }
    }
    const self = this;
    const listener = Bun.listen<ConnectionState>({
      unix: this.socketPath,
      socket: {
        open(socket) {
          const state: ConnectionState = { buffer: "", isSubscriber: false };
          socket.data = state;
          self.connections.add(socket as unknown as SocketHandle);
        },
        data(socket, chunk) {
          const text =
            typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
          const state = socket.data;
          if (!state) return;
          state.buffer += text;
          let nl = state.buffer.indexOf("\n");
          while (nl !== -1) {
            const line = state.buffer.slice(0, nl).trim();
            state.buffer = state.buffer.slice(nl + 1);
            nl = state.buffer.indexOf("\n");
            if (line.length === 0) continue;
            void self.dispatchLine(socket as unknown as SocketHandle, line);
          }
        },
        close(socket) {
          self.subscribers.delete(socket as unknown as SocketHandle);
          self.connections.delete(socket as unknown as SocketHandle);
        },
        error(_socket, err) {
          verbose(`meeting daemon: socket error: ${errMsg(err)}`);
        },
      },
    });
    this.listener = listener as unknown as SocketListener;
    // Lock down to user-only after bind. We don't need group/other to
    // touch the socket — the menubar and CLI both run as the same
    // user.
    try {
      chmodSync(this.socketPath, 0o600);
    } catch (e) {
      warn(`meeting daemon: chmod socket failed: ${errMsg(e)}`);
    }
  }

  private async dispatchLine(socket: SocketHandle, line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      this.writeJson(socket, {
        error: `invalid JSON: ${errMsg(e)}`,
      });
      return;
    }
    const parsed = SocketRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.writeJson(socket, { error: `invalid op: ${parsed.error.message}` });
      return;
    }
    try {
      await this.handleOp(socket, parsed.data);
    } catch (e) {
      this.writeJson(socket, {
        error: `internal: ${errMsg(e)}`,
      });
      // Per the spec: an exception in a per-connection handler does
      // not take the daemon down. We log and continue.
      warn(`meeting daemon: handler exception on ${parsed.data.op}: ${errMsg(e)}`);
    }
  }

  private async handleOp(socket: SocketHandle, op: SocketRequest): Promise<void> {
    switch (op.op) {
      case "status":
        this.writeJson(socket, this.snapshotStatus());
        return;
      case "record_start": {
        const r = await this.handleRecordStart({
          label: op.label ?? null,
          captureSystemAudio: op.system_audio === true,
          source: "socket",
        });
        this.writeJson(socket, r);
        return;
      }
      case "record_stop": {
        const r = await this.handleRecordStop({ discard: op.discard === true });
        this.writeJson(socket, r);
        return;
      }
      case "undo_last": {
        const r = this.handleUndoLast();
        this.writeJson(socket, r);
        return;
      }
      case "queue_list": {
        const db = openArchive(this.opts.archive, {});
        try {
          this.writeJson(socket, { items: queue.list(db) });
        } finally {
          db.close();
        }
        return;
      }
      case "queue_state": {
        this.writeJson(socket, this.processor.state());
        return;
      }
      case "queue_start": {
        const before = readState(this.opts.archive);
        // Kick the processor loop; don't await its full drain because
        // that would tie the response to a possibly multi-minute
        // operation. The loop runs in the background and pushes
        // `queue_state_changed` events as it progresses.
        if (before !== "processing") {
          void this.processor.start();
        }
        // Re-read after kick so batch_size reflects the start.
        const snap = this.processor.state();
        this.writeJson(socket, {
          ok: true,
          state: snap.state,
          batch_size: snap.batch_size,
        });
        this.pushEvent({ event: "queue_state_changed", ...snap });
        return;
      }
      case "queue_pause": {
        // pause() is async — fire it and respond immediately. Tests /
        // CLI that need to wait for the transition can poll
        // queue_state.
        void this.processor.pause();
        const snap = this.processor.state();
        this.writeJson(socket, { ok: true, state: snap.state });
        this.pushEvent({ event: "queue_state_changed", ...snap });
        return;
      }
      case "queue_discard": {
        const r = this.processor.discard(op.id);
        if (r.ok) {
          this.writeJson(socket, { ok: true });
          this.pushEvent({ event: "queue_changed", reason: "discard", id: op.id });
        } else {
          this.writeJson(socket, { error: r.reason ?? "discard refused", id: op.id });
        }
        return;
      }
      case "subscribe": {
        if (!socket.data) return;
        socket.data.isSubscriber = true;
        this.subscribers.add(socket);
        // Send an immediate snapshot so the menubar can render
        // before any state changes.
        this.writeJson(socket, { event: "subscribed", status: this.snapshotStatus() });
        return;
      }
      case "config_reload": {
        try {
          this.loadPopupConfig();
        } catch (e) {
          // loadPopupConfig already logs; surface the error to the
          // CLI caller too so a malformed config is visible at the
          // mutation site.
          this.writeJson(socket, { error: `config_reload: ${errMsg(e)}` });
          return;
        }
        this.writeJson(socket, { ok: true, config: this.popupConfig });
        this.pushEvent({ event: "config_reloaded", config: this.popupConfig });
        return;
      }
    }
  }

  /* ----------------------------- recording ------------------------------- */

  private async handleRecordStart(args: {
    label: string | null;
    captureSystemAudio: boolean;
    source: "socket" | "popup";
  }): Promise<{ ok: true; audio_path: string } | { error: string; audio_path?: string }> {
    if (this.recording) {
      return {
        error: "already_recording",
        audio_path: this.recording.handle.audioPath,
      };
    }
    if (args.captureSystemAudio && !this.systemAudioAcked()) {
      return { error: "system_audio_not_acked" };
    }
    let handle: RecordingHandle;
    try {
      handle = await this.deps.startRecording(
        { label: args.label ?? undefined, captureSystemAudio: args.captureSystemAudio },
        { archive: this.opts.archive, incomingDir: this.incomingDir },
      );
    } catch (e) {
      return { error: `recorder failed: ${errMsg(e)}` };
    }
    this.recording = {
      handle,
      since: handle.startedAt,
      label: handle.label,
      captureSystemAudio: handle.captureSystemAudio,
    };
    this.pushEvent({ event: "status_changed", reason: `record_start:${args.source}` });
    info(
      `meeting daemon: recording started (source=${args.source} path=${handle.audioPath}${
        args.captureSystemAudio ? " +sys" : ""
      })`,
    );
    return { ok: true, audio_path: handle.audioPath };
  }

  private async handleRecordStop(args: {
    discard: boolean;
  }): Promise<{ ok: true } | { error: string }> {
    if (!this.recording) {
      return { error: "not_recording" };
    }
    const rec = this.recording;
    let result: StoppedRecording;
    try {
      result = await this.deps.stopRecording(
        rec.handle,
        { discard: args.discard },
        { archive: this.opts.archive, incomingDir: this.incomingDir },
      );
    } catch (e) {
      this.recording = null;
      this.pushEvent({ event: "status_changed", reason: "record_stop_error" });
      return { error: `recorder stop failed: ${errMsg(e)}` };
    }
    this.recording = null;
    this.pushEvent({ event: "status_changed", reason: "record_stopped" });
    if (result.queueRow != null) {
      this.pushEvent({ event: "queue_changed", reason: "record_save" });
    }
    return { ok: true };
  }

  private handleUndoLast(): { ok: true } | { error: string } {
    if (!this.undo) return { error: "no_undo_available" };
    if (this.undo.until < Date.now()) {
      this.clearUndo();
      return { error: "no_undo_available" };
    }
    const undo = this.undo;
    // Verify the row still exists; user may have already discarded it
    // via the queue_discard op or the wav may have been processed.
    const db = openArchive(this.opts.archive, {});
    let row: queue.MeetingQueueRow | null;
    try {
      row = queue.getById(db, undo.queueRowId);
    } finally {
      db.close();
    }
    if (!row || row.status !== "pending") {
      this.clearUndo();
      return { error: "no_undo_available" };
    }
    const db2 = openArchive(this.opts.archive, {});
    try {
      queue.markDiscarded(db2, undo.queueRowId);
    } finally {
      db2.close();
    }
    // Unlink the wav (best-effort).
    try {
      if (existsSync(undo.wavPath)) {
        Bun.spawnSync(["rm", "-f", undo.wavPath]);
      }
    } catch {
      // best-effort
    }
    this.clearUndo();
    this.pushEvent({ event: "queue_changed", reason: "undo_last", id: undo.queueRowId });
    this.pushEvent({ event: "status_changed", reason: "undo_last" });
    return { ok: true };
  }

  private openUndoWindow(queueRowId: number, wavPath: string): void {
    if (this.undo) clearTimeout(this.undo.timer);
    const until = Date.now() + this.undoWindowMs;
    const timer = setTimeout(() => {
      this.clearUndo();
      this.pushEvent({ event: "status_changed", reason: "undo_window_expired" });
    }, this.undoWindowMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.undo = { queueRowId, wavPath, until, timer };
  }

  private clearUndo(): void {
    if (this.undo) {
      clearTimeout(this.undo.timer);
      this.undo = null;
    }
  }

  /* --------------------------- events helper ----------------------------- */

  private startEventsHelper(): void {
    if (this.stopping) return;
    try {
      this.eventsHandle = this.deps.spawnEventsHelper();
      this.eventsRestartFailures = 0;
    } catch (e) {
      this.scheduleEventsRestart(`spawn failed: ${errMsg(e)}`);
      return;
    }
    const handle = this.eventsHandle;
    this.eventsConsumerPromise = this.consumeEvents(handle).finally(() => {
      if (this.stopping) return;
      // EOF / iterator threw — schedule a restart unless we're shutting down.
      this.scheduleEventsRestart("EOF or iterator error");
    });
  }

  private async consumeEvents(handle: EventsHandle): Promise<void> {
    try {
      for await (const ev of handle.events) {
        if (this.detector) {
          await this.detector.handleEvent(ev as EventLine);
        }
      }
    } catch (e) {
      verbose(`meeting daemon: events iterator threw: ${errMsg(e)}`);
    }
  }

  private scheduleEventsRestart(reason: string): void {
    if (this.stopping) return;
    const idx = Math.min(this.eventsRestartFailures, this.eventsBackoffMs.length - 1);
    const delay = this.eventsBackoffMs[idx] ?? 30_000;
    this.eventsRestartFailures += 1;
    const level = this.eventsRestartFailures > 5 ? "loud" : "quiet";
    if (level === "loud") {
      error(
        `meeting daemon: events helper has failed ${this.eventsRestartFailures} times (last: ${reason}); retry in ${delay}ms`,
      );
    } else {
      warn(`meeting daemon: events helper down (${reason}); retry in ${delay}ms`);
    }
    this.eventsRestartTimer = setTimeout(() => {
      this.eventsRestartTimer = null;
      this.startEventsHelper();
    }, delay);
    if (typeof (this.eventsRestartTimer as { unref?: () => void }).unref === "function") {
      (this.eventsRestartTimer as { unref: () => void }).unref();
    }
  }

  /* ----------------------------- helpers --------------------------------- */

  private buildProcessorOptions(): ProcessorOptions {
    // Wire the processor's state-change + item-change callbacks
    // into our push-event fan-out. Without these the menubar would
    // see no movement once the processor takes over autonomously
    // (queue_start fires one synchronous queue_state_changed via
    // the socket handler, but subsequent transitions — pending →
    // transcribing → completed, drained → paused — happen inside
    // processor.loop() and have no other path to subscribers).
    return {
      archive: this.opts.archive,
      sourceDir: this.opts.sourceDir,
      sourceDb: this.opts.sourceDb,
      swDbPath: this.opts.swDbPath,
      swRecordingsDir: this.opts.swRecordingsDir,
      embedModel: this.opts.embedModel,
      ollamaHost: this.opts.ollamaHost,
      keepAudio: this.opts.keepAudio,
      hooks: this.opts.processorHooks,
      onStateChange: (snap) => {
        this.pushEvent({ event: "queue_state_changed", ...snap });
      },
      onItemChanged: (id, status) => {
        this.pushEvent({ event: "queue_changed", reason: `item:${status}`, id });
      },
    };
  }

  private async maybeResumeProcessor(): Promise<void> {
    const persisted = readState(this.opts.archive);
    if (persisted === "processing") {
      info("meeting daemon: persisted state is 'processing'; resuming loop");
      void this.processor.start().finally(() => {
        // After the resumed loop drains, push a final state event so
        // any subscribers know the queue settled.
        this.pushEvent({ event: "queue_state_changed", ...this.processor.state() });
      });
    } else if (persisted === "pausing") {
      info("meeting daemon: persisted state was 'pausing'; transitioning to 'paused'");
      const db = openArchive(this.opts.archive, {});
      try {
        db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
          MEETING_QUEUE_STATE_KEY,
          "paused",
        );
      } finally {
        db.close();
      }
    }
  }

  /**
   * Scan `incomingDir` for wav files that don't have a meeting_queue
   * row referencing them. Files older than 10 minutes get
   * auto-enqueued; fresher files are moved to quarantine.
   *
   * Two pathologies this handles:
   *   - Daemon crashed mid-record → wav on disk, no row → recover.
   *   - Another process is mid-record under a different daemon
   *     (shouldn't happen but cheap to guard) → quarantine so we
   *     don't enqueue an actively-written file.
   */
  private async scanOrphanWavs(): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(this.incomingDir);
    } catch (e) {
      verbose(`meeting daemon: orphan scan skipped (incomingDir unreadable): ${errMsg(e)}`);
      return;
    }
    const wavs = entries.filter((n) => n.endsWith(".wav"));
    if (wavs.length === 0) return;

    // Build a set of audio paths the queue already references.
    const db = openArchive(this.opts.archive, {});
    let known: Set<string>;
    try {
      const rows = queue.list(db);
      known = new Set(rows.map((r) => r.audio_path));
    } finally {
      db.close();
    }

    const now = Date.now();
    for (const name of wavs) {
      const full = join(this.incomingDir, name);
      if (known.has(full)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const ageMs = now - st.mtime.getTime();
      if (ageMs >= ORPHAN_RECOVERY_MIN_AGE_MS) {
        // Recover: enqueue with captured_at = mtime.
        const db2 = openArchive(this.opts.archive, {});
        try {
          queue.enqueue(db2, {
            audio_path: full,
            captured_at: st.mtime.toISOString(),
            duration_ms: null,
            label: null,
          });
          info(`meeting daemon: recovered orphan wav ${full} (age=${Math.round(ageMs / 1000)}s)`);
        } catch (e) {
          warn(`meeting daemon: failed to enqueue orphan wav ${full}: ${errMsg(e)}`);
        } finally {
          db2.close();
        }
      } else {
        // Quarantine: move so we don't repeatedly re-scan a file
        // that's racing with an in-flight recording.
        const target = join(this.quarantineDir, name);
        try {
          await rename(full, target);
          info(`meeting daemon: quarantined fresh orphan wav ${name} (age=${Math.round(ageMs / 1000)}s)`);
        } catch (e) {
          warn(`meeting daemon: failed to quarantine orphan ${name}: ${errMsg(e)}`);
        }
      }
    }
  }

  private snapshotStatus(): object {
    let queuePending = 0;
    const db = openArchive(this.opts.archive, {});
    try {
      queuePending = queue.countPending(db);
    } finally {
      db.close();
    }
    const lastDetect = this.lastEdgeSignal
      ? {
          confidence: this.lastEdgeSignal.confidence,
          reason: this.lastEdgeSignal.reason,
          evidence: this.lastEdgeSignal.evidence,
        }
      : null;
    return {
      recording: this.recording != null,
      since: this.recording?.since ?? null,
      audio_path: this.recording?.handle.audioPath ?? null,
      queue_pending: queuePending,
      last_detect: lastDetect,
      undo_window_until: this.undo ? new Date(this.undo.until).toISOString() : null,
    };
  }

  private systemAudioAcked(): boolean {
    const db = openArchive(this.opts.archive, {});
    try {
      return getConfig(db, CONFIG_SYSTEM_AUDIO_ACK) === "1";
    } finally {
      db.close();
    }
  }

  /**
   * Read the popup config from the DB and cache it on the
   * instance. Falls back to `defaultConfig()` with a logged warning
   * if the stored row is malformed — we never want a bad config
   * row to block startup or break popup decisions outright.
   */
  private loadPopupConfig(): void {
    const db = openArchive(this.opts.archive, {});
    try {
      this.popupConfig = readConfig(db);
    } catch (e) {
      warn(
        `meeting daemon: failed to read popup config; using defaults (${errMsg(e)})`,
      );
      this.popupConfig = defaultConfig();
    } finally {
      db.close();
    }
  }

  /**
   * Test-only accessor. The popup config is a private cache; tests
   * that want to assert behaviour against it without poking the DB
   * read it through this method.
   */
  getPopupConfig(): PopupConfig {
    return this.popupConfig;
  }

  private systemAudioDefault(): boolean {
    const db = openArchive(this.opts.archive, {});
    try {
      return getConfig(db, CONFIG_SYSTEM_AUDIO_DEFAULT) === "1";
    } finally {
      db.close();
    }
  }

  /** Push a JSON event to every subscriber. Closed sockets are pruned. */
  private pushEvent(payload: object): void {
    if (this.subscribers.size === 0) return;
    const line = `${JSON.stringify(payload)}\n`;
    const dead: SocketHandle[] = [];
    for (const sub of this.subscribers) {
      try {
        sub.write(line);
      } catch {
        dead.push(sub);
      }
    }
    for (const d of dead) this.subscribers.delete(d);
  }

  private writeJson(socket: SocketHandle, payload: object): void {
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch (e) {
      verbose(`meeting daemon: write failed: ${errMsg(e)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Top-level entry — `swrag meeting watch` runs this                          */
/* -------------------------------------------------------------------------- */

export async function runDaemonForeground(opts: DaemonOptions): Promise<void> {
  const daemon = new MeetingDaemon(opts);
  let stopped = false;
  const onSignal = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    info(`meeting daemon: ${signal} received; shutting down`);
    try {
      await daemon.stop();
    } catch (e) {
      error(`meeting daemon: stop threw: ${errMsg(e)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
  await daemon.start();
  // Block forever — signal handler is the only exit path.
  await new Promise<void>(() => {
    // intentionally never resolves
  });
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  });
}
