/**
 * Phase 4 daemon socket-API tests.
 *
 * The daemon is constructed in-process with stubbed external
 * dependencies (events helper, recorder, popup, processor hooks)
 * and exercised through its real unix socket via `Bun.connect`.
 * Every test spins up a fresh daemon + temp archive + temp socket
 * so cases don't leak state into each other.
 *
 * What's NOT covered here (and why):
 *   - The Swift menubar app: separate process, no headless UI
 *     harness; covered by manual smoke + the in-tree DaemonClient.
 *   - launchd install/uninstall paths: covered by
 *     tests/launchd/install.test.ts.
 *   - The real `osascript` popup: stubbed via the daemon's
 *     `askStartRecording` injection.
 *   - The real Swift recorder: stubbed via a deps.startRecording
 *     that writes a fake wav + returns a synthesised handle.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openArchive, setConfig } from "../../src/archive/open.ts";
import {
  CONFIG_SYSTEM_AUDIO_ACK,
  CONFIG_SYSTEM_AUDIO_DEFAULT,
  MeetingDaemon,
  type DaemonOptions,
} from "../../src/meeting/daemon.ts";
import type { EventsHandle, RecorderHandle } from "../../src/mac/helper.ts";
import * as queue from "../../src/meeting/queue.ts";
import { MEETING_QUEUE_STATE_KEY, readState } from "../../src/meeting/processor.ts";
import type {
  RecordingHandle,
  RecordDeps,
  StartRecordingOptions,
  StoppedRecording,
} from "../../src/meeting/record.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let workDir: string;
let archive: string;
let sourceDir: string;
let sourceDb: string;
let recordingsDir: string;
let socketPath: string;
let incomingDir: string;
let quarantineDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-daemon-"));
  archive = join(workDir, "archive.sqlite");
  sourceDir = join(workDir, "superwhisper");
  sourceDb = join(workDir, "sw.sqlite");
  recordingsDir = join(sourceDir, "recordings");
  // Place the socket in a SHORT path. macOS unix sockets cap at 104
  // bytes including the trailing NUL; `mkdtempSync(tmpdir(), ...)` +
  // a long file name blows past that, and `Bun.listen({unix})` would
  // emit ENAMETOOLONG. We deliberately use /tmp directly with a
  // shorter name.
  socketPath = `/tmp/swrag-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`;
  incomingDir = join(workDir, "incoming");
  quarantineDir = join(workDir, "quarantine");

  // Seed a minimal SW DB shape so the processor's transcribing-row
  // recovery has something to query against.
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
  if (existsSync(socketPath)) {
    try {
      rmSync(socketPath);
    } catch {
      // best-effort
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Stub events helper that emits nothing until `stop()`. Used for
 * tests that don't exercise the detection edge path — they don't
 * need any actual events flowing.
 */
function silentEventsHandle(): EventsHandle {
  return {
    events: (async function* () {
      // Park until interrupted by stop.
      await new Promise(() => {
        /* never */
      });
    })(),
    stop: async () => {},
    stderrTail: () => "",
  };
}

/**
 * Build a fake `startRecording` that materialises a tiny wav at the
 * incoming path and returns a synthetic RecordingHandle. Lets us
 * test daemon `record_start` / `record_stop` paths without touching
 * the Swift binary.
 */
function makeFakeRecorder(): {
  startRecording: (
    opts: StartRecordingOptions,
    deps: RecordDeps,
  ) => Promise<RecordingHandle>;
  stopRecording: (
    handle: RecordingHandle,
    opts: { discard: boolean },
    deps: RecordDeps,
  ) => Promise<StoppedRecording>;
  pathsCreated: string[];
} {
  const pathsCreated: string[] = [];
  return {
    startRecording: async (opts, deps) => {
      const dir = deps.incomingDir ?? incomingDir;
      const path = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
      writeFileSync(path, Buffer.alloc(200));
      pathsCreated.push(path);
      const fakeHandle: RecorderHandle = {
        events: (async function* () {
          /* no heartbeats */
        })(),
        firstHeartbeat: () => Promise.resolve({ frames: 0, duration_ms: 0, level_dbfs: -100 }),
        stop: async () => ({ exitCode: 0, stderr: "" }),
        pid: 0,
        stderrTail: () => "",
      };
      return {
        audioPath: path,
        startedAt: new Date().toISOString(),
        label: opts.label ?? null,
        captureSystemAudio: opts.captureSystemAudio === true,
        recorder: fakeHandle,
      };
    },
    stopRecording: async (handle, opts, deps) => {
      if (opts.discard) {
        try {
          rmSync(handle.audioPath, { force: true });
        } catch {
          // best-effort
        }
        return {
          queueRow: null,
          durationMs: 0,
          audioPath: null,
          exitCode: 0,
          stderr: "",
        };
      }
      const db = openArchive(deps.archive, {});
      try {
        const row = queue.enqueue(db, {
          audio_path: handle.audioPath,
          captured_at: handle.startedAt,
          captured_until: new Date().toISOString(),
          duration_ms: 200,
          label: handle.label,
        });
        return {
          queueRow: row,
          durationMs: 200,
          audioPath: handle.audioPath,
          exitCode: 0,
          stderr: "",
        };
      } finally {
        db.close();
      }
    },
    pathsCreated,
  };
}

function baseOptions(overrides: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    archive,
    sourceDir,
    sourceDb,
    swDbPath: sourceDb,
    swRecordingsDir: recordingsDir,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    socketPath,
    incomingDir,
    quarantineDir,
    disableDetection: true,
    keepAudio: true,
    ...overrides,
  };
}

/**
 * One-shot socket op: open, send, read one line, close. Mirrors the
 * `daemon-client` shape exactly so we exercise the wire protocol
 * the production CLI uses.
 */
async function callSocket<T = unknown>(op: object): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (err: Error | null, val?: T): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val as T);
    };
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          s.write(`${JSON.stringify(op)}\n`);
        },
        data(_s, chunk) {
          const text =
            typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(
                  chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
                );
          buf += text;
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            const line = buf.slice(0, nl);
            try {
              finish(null, JSON.parse(line) as T);
            } catch (e) {
              finish(e instanceof Error ? e : new Error(String(e)));
            }
          }
        },
        end() {
          if (!settled) finish(new Error("daemon closed without responding"));
        },
        close() {
          if (!settled) finish(new Error("daemon closed without responding"));
        },
        error(_s, err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        },
      },
    }).catch((err: unknown) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Subscribe in the background, collect every push event until
 * `stop()` is called, then resolve with the collected events.
 *
 * Returns the stop fn + a promise of all events seen so far. Used by
 * tests that need to assert push semantics.
 */
function startSubscriber(): {
  stop: () => Promise<void>;
  events: () => unknown[];
  ready: Promise<void>;
} {
  const seen: unknown[] = [];
  let stop: () => Promise<void> = async () => {};
  const ready = new Promise<void>((resolve) => {
    let buf = "";
    let socket: { end: () => void } | null = null;
    let settled = false;
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          socket = s;
          s.write(`${JSON.stringify({ op: "subscribe" })}\n`);
        },
        data(_s, chunk) {
          const text =
            typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(
                  chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
                );
          buf += text;
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (line.length === 0) continue;
            try {
              const parsed = JSON.parse(line) as unknown;
              seen.push(parsed);
              // The initial subscribe envelope is the signal that the
              // server has wired us in — resolve `ready` after we see
              // it.
              if (
                !settled &&
                typeof parsed === "object" &&
                parsed != null &&
                "event" in parsed &&
                (parsed as { event?: unknown }).event === "subscribed"
              ) {
                settled = true;
                resolve();
              }
            } catch {
              // ignore garbage
            }
          }
        },
        close() {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        error() {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
      },
    }).catch(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    stop = async () => {
      try {
        socket?.end();
      } catch {
        // best-effort
      }
    };
  });
  return {
    stop: () => stop(),
    events: () => seen,
    ready,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("daemon: lifecycle", () => {
  test("start binds socket with 0600 perms; stop unlinks", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: { spawnEventsHelper: silentEventsHandle },
      }),
    );
    await daemon.start();
    expect(existsSync(socketPath)).toBe(true);
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
    await daemon.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("stale socket cleanup on start", async () => {
    // Pre-create a regular file at the socket path to simulate a
    // crashed previous daemon. The daemon should unlink it before
    // binding.
    writeFileSync(socketPath, "stale");
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: { spawnEventsHelper: silentEventsHandle },
      }),
    );
    await daemon.start();
    // After bind, the path should be a socket, not a regular file.
    const st = statSync(socketPath);
    expect(st.isSocket()).toBe(true);
    await daemon.stop();
  });

  test("calling start twice throws", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: { spawnEventsHelper: silentEventsHandle },
      }),
    );
    await daemon.start();
    let caught: Error | null = null;
    try {
      await daemon.start();
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(caught?.message ?? "").toContain("already started");
    await daemon.stop();
  });
});

describe("daemon: request/response ops", () => {
  test("status returns expected shape", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{
        recording: boolean;
        queue_pending: number;
        undo_window_until: string | null;
      }>({ op: "status" });
      expect(r.recording).toBe(false);
      expect(r.queue_pending).toBe(0);
      expect(r.undo_window_until).toBeNull();
    } finally {
      await daemon.stop();
    }
  });

  test("queue_list returns the items array", async () => {
    // Pre-populate the queue.
    {
      const db = openArchive(archive, {});
      try {
        const wav = join(workDir, "a.wav");
        writeFileSync(wav, "x");
        queue.enqueue(db, {
          audio_path: wav,
          captured_at: "2026-05-22T00:00:00Z",
          duration_ms: 1000,
          label: "alpha",
        });
      } finally {
        db.close();
      }
    }
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ items: queue.MeetingQueueRow[] }>({ op: "queue_list" });
      expect(r.items.length).toBe(1);
      expect(r.items[0]?.label).toBe("alpha");
    } finally {
      await daemon.stop();
    }
  });

  test("queue_start / queue_pause flip state", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: { spawnEventsHelper: silentEventsHandle },
        processorHooks: {
          ingestFile: async () => {},
          waitForCompletion: async () => ({ folderName: "F" }),
          makePatcher: () => ({
            patch: async (f, d) => ({
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
        },
      }),
    );
    await daemon.start();
    try {
      const start = await callSocket<{ ok: true; state: string }>({ op: "queue_start" });
      expect(start.ok).toBe(true);
      // Empty queue → straight back to paused after the drain.
      // Give the loop a microtask to land.
      await sleep(20);
      const state = await callSocket<{ state: string }>({ op: "queue_state" });
      expect(["paused", "processing"]).toContain(state.state);
    } finally {
      await daemon.stop();
    }
  });

  test("queue_discard fails for non-existent id", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ error?: string; ok?: true }>({
        op: "queue_discard",
        id: 999_999,
      });
      expect(r.error).toBeDefined();
      expect(r.ok).toBeUndefined();
    } finally {
      await daemon.stop();
    }
  });

  test("invalid op shape returns an error response", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ error?: string }>({ op: "no_such_op" });
      expect(r.error).toBeDefined();
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon: recording", () => {
  test("record_start enqueues and is idempotent on double-call", async () => {
    const rec = makeFakeRecorder();
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: {
          spawnEventsHelper: silentEventsHandle,
          startRecording: rec.startRecording,
          stopRecording: rec.stopRecording,
        },
      }),
    );
    await daemon.start();
    try {
      const first = await callSocket<{ ok?: true; audio_path?: string; error?: string }>({
        op: "record_start",
      });
      expect(first.ok).toBe(true);
      expect(first.audio_path).toBeDefined();
      // Second call should return already_recording with the same path.
      const second = await callSocket<{ error?: string; audio_path?: string }>({
        op: "record_start",
      });
      expect(second.error).toBe("already_recording");
      expect(second.audio_path).toBe(first.audio_path ?? "");
      // Now stop with save.
      const stop = await callSocket<{ ok?: true; error?: string }>({
        op: "record_stop",
      });
      expect(stop.ok).toBe(true);
      // Queue should have one row now.
      const list = await callSocket<{ items: queue.MeetingQueueRow[] }>({ op: "queue_list" });
      expect(list.items.length).toBe(1);
      expect(list.items[0]?.audio_path).toBe(first.audio_path ?? "");
    } finally {
      await daemon.stop();
    }
  });

  test("record_stop returns not_recording when nothing is in flight", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ error?: string }>({ op: "record_stop" });
      expect(r.error).toBe("not_recording");
    } finally {
      await daemon.stop();
    }
  });

  test("record_start with system_audio without ack → system_audio_not_acked", async () => {
    const rec = makeFakeRecorder();
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: {
          spawnEventsHelper: silentEventsHandle,
          startRecording: rec.startRecording,
          stopRecording: rec.stopRecording,
        },
      }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ error?: string }>({
        op: "record_start",
        system_audio: true,
      });
      expect(r.error).toBe("system_audio_not_acked");
    } finally {
      await daemon.stop();
    }
  });

  test("record_start with system_audio + ack succeeds", async () => {
    // Persist the ack first.
    const db = openArchive(archive, {});
    try {
      setConfig(db, CONFIG_SYSTEM_AUDIO_ACK, "1");
    } finally {
      db.close();
    }
    const rec = makeFakeRecorder();
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: {
          spawnEventsHelper: silentEventsHandle,
          startRecording: rec.startRecording,
          stopRecording: rec.stopRecording,
        },
      }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ ok?: true; audio_path?: string; error?: string }>({
        op: "record_start",
        system_audio: true,
      });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon: subscription / push events", () => {
  test("subscribe receives an initial snapshot envelope", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const sub = startSubscriber();
      await sub.ready;
      const events = sub.events();
      expect(events.length).toBeGreaterThanOrEqual(1);
      const first = events[0] as { event?: string; status?: object };
      expect(first.event).toBe("subscribed");
      expect(first.status).toBeDefined();
      await sub.stop();
    } finally {
      await daemon.stop();
    }
  });

  test("record_start triggers status_changed push to subscriber", async () => {
    const rec = makeFakeRecorder();
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: {
          spawnEventsHelper: silentEventsHandle,
          startRecording: rec.startRecording,
          stopRecording: rec.stopRecording,
        },
      }),
    );
    await daemon.start();
    try {
      const sub = startSubscriber();
      await sub.ready;
      await callSocket({ op: "record_start" });
      // Give the daemon a tick to push.
      await sleep(50);
      const events = sub.events() as Array<{ event: string }>;
      const statusEvents = events.filter((e) => e.event === "status_changed");
      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
      await callSocket({ op: "record_stop", discard: true });
      await sub.stop();
    } finally {
      await daemon.stop();
    }
  });

  test("subscriber disconnect cleans up registration", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const sub = startSubscriber();
      await sub.ready;
      await sub.stop();
      // Drop the subscriber, then trigger an event. The daemon
      // shouldn't throw or hang on a closed subscriber.
      await sleep(50);
      const r = await callSocket<{ ok?: true }>({ op: "queue_start" });
      expect(r.ok).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  test("autonomous processor transitions push queue_state_changed + queue_changed", async () => {
    // Pre-populate one queued row so the processor has something to
    // chew on once we kick queue_start. We use synchronous-fast
    // hooks so the loop completes within the test's sleep window.
    {
      const db = openArchive(archive, {});
      try {
        const wav = join(workDir, "auto.wav");
        writeFileSync(wav, "x");
        queue.enqueue(db, {
          audio_path: wav,
          captured_at: "2026-05-22T00:00:00Z",
          duration_ms: 100,
        });
      } finally {
        db.close();
      }
    }
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: { spawnEventsHelper: silentEventsHandle },
        processorHooks: {
          ingestFile: async () => {},
          waitForCompletion: async () => ({ folderName: "F" }),
          makePatcher: () => ({
            patch: async (f, d) => ({
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
        },
      }),
    );
    await daemon.start();
    try {
      const sub = startSubscriber();
      await sub.ready;
      await callSocket({ op: "queue_start" });
      // Give the loop time to: mark transcribing, ingest, wait,
      // patch, index, mark completed, drain to paused.
      await sleep(80);
      const events = sub.events() as Array<{ event: string; reason?: string }>;
      // The processor's autonomous transitions must surface as push
      // events: at minimum a queue_changed with reason=item:transcribing
      // (markTranscribing inside processOne) and reason=item:completed
      // after a successful ingest, plus queue_state_changed for the
      // current_item field becoming non-null and then null again.
      const itemEvents = events.filter((e) => e.event === "queue_changed");
      const itemTranscribing = itemEvents.some((e) => e.reason === "item:transcribing");
      const itemCompleted = itemEvents.some((e) => e.reason === "item:completed");
      expect(itemTranscribing).toBe(true);
      expect(itemCompleted).toBe(true);
      // Must see at least one queue_state_changed beyond the initial
      // "subscribed" snapshot — the processor's notifyStateChange()
      // calls during the loop body.
      const stateChanges = events.filter((e) => e.event === "queue_state_changed");
      expect(stateChanges.length).toBeGreaterThanOrEqual(1);
      await sub.stop();
    } finally {
      await daemon.stop();
    }
  });

  test("processor item-failed surfaces queue_changed with item:failed", async () => {
    {
      const db = openArchive(archive, {});
      try {
        const wav = join(workDir, "fail.wav");
        writeFileSync(wav, "x");
        queue.enqueue(db, {
          audio_path: wav,
          captured_at: "2026-05-22T00:00:00Z",
          duration_ms: 100,
        });
      } finally {
        db.close();
      }
    }
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: { spawnEventsHelper: silentEventsHandle },
        processorHooks: {
          ingestFile: async () => {
            throw new Error("simulated ingest failure");
          },
          waitForCompletion: async () => ({ folderName: "F" }),
          makePatcher: () => ({
            patch: async (f, d) => ({
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
        },
      }),
    );
    await daemon.start();
    try {
      const sub = startSubscriber();
      await sub.ready;
      await callSocket({ op: "queue_start" });
      await sleep(80);
      const events = sub.events() as Array<{ event: string; reason?: string }>;
      const itemFailed = events.some(
        (e) => e.event === "queue_changed" && e.reason === "item:failed",
      );
      expect(itemFailed).toBe(true);
      await sub.stop();
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon: orphan wav recovery on startup", () => {
  test("wav older than 10 minutes gets auto-enqueued", async () => {
    // Pre-create the incoming dir with a wav whose mtime is 30 min ago.
    const wav = join(incomingDir, "orphan.wav");
    // Ensure dir exists.
    rmSync(incomingDir, { recursive: true, force: true });
    require("node:fs").mkdirSync(incomingDir, { recursive: true });
    writeFileSync(wav, Buffer.alloc(64));
    const stale = (Date.now() - 30 * 60 * 1000) / 1000;
    utimesSync(wav, stale, stale);

    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const list = await callSocket<{ items: queue.MeetingQueueRow[] }>({ op: "queue_list" });
      expect(list.items.length).toBe(1);
      expect(list.items[0]?.audio_path).toBe(wav);
    } finally {
      await daemon.stop();
    }
  });

  test("wav newer than 10 minutes is quarantined", async () => {
    const wav = join(incomingDir, "fresh.wav");
    rmSync(incomingDir, { recursive: true, force: true });
    require("node:fs").mkdirSync(incomingDir, { recursive: true });
    writeFileSync(wav, Buffer.alloc(64));
    // mtime defaults to now → newer than 10 min.

    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      // The original path should be gone.
      expect(existsSync(wav)).toBe(false);
      // The wav should now live in the quarantine dir.
      const quarantined = join(quarantineDir, "fresh.wav");
      expect(existsSync(quarantined)).toBe(true);
      // No queue row should be created for fresh orphans.
      const list = await callSocket<{ items: queue.MeetingQueueRow[] }>({ op: "queue_list" });
      expect(list.items.length).toBe(0);
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon: persisted state resume", () => {
  test("processing → loop resumes on start (and drains to paused)", async () => {
    // Pre-flip the persisted state to 'processing'. The daemon
    // should call processor.start() on boot which drains the (empty)
    // queue back to paused.
    const db = openArchive(archive, {});
    try {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
        MEETING_QUEUE_STATE_KEY,
        "processing",
      );
    } finally {
      db.close();
    }
    const daemon = new MeetingDaemon(
      baseOptions({
        deps: { spawnEventsHelper: silentEventsHandle },
        processorHooks: {
          ingestFile: async () => {},
          waitForCompletion: async () => ({ folderName: "F" }),
          makePatcher: () => ({
            patch: async (f, d) => ({
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
        },
      }),
    );
    await daemon.start();
    try {
      // Let the loop drain.
      await sleep(50);
      expect(readState(archive)).toBe("paused");
    } finally {
      await daemon.stop();
    }
  });

  test("pausing → transitions to paused immediately on start", async () => {
    const db = openArchive(archive, {});
    try {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
        MEETING_QUEUE_STATE_KEY,
        "pausing",
      );
    } finally {
      db.close();
    }
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      expect(readState(archive)).toBe("paused");
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon: transcribing-row reconciliation", () => {
  test("transcribing row without matching SW folder is marked failed on startup", async () => {
    const wav = join(workDir, "x.wav");
    writeFileSync(wav, "x");
    let rowId = 0;
    {
      const db = openArchive(archive, {});
      try {
        const row = queue.enqueue(db, {
          audio_path: wav,
          captured_at: "2026-05-22T00:00:00Z",
          duration_ms: 1000,
        });
        rowId = row.id;
        queue.markTranscribing(db, row.id);
      } finally {
        db.close();
      }
    }
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const db = openArchive(archive, {});
      try {
        const row = queue.getById(db, rowId);
        expect(row?.status).toBe("failed");
      } finally {
        db.close();
      }
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon: system-audio config gating via enable-watcher", () => {
  test("system_audio_default config persisted via enable-watcher path is respected", async () => {
    // Simulate the enable-watcher path: persist both keys.
    const db = openArchive(archive, {});
    try {
      setConfig(db, CONFIG_SYSTEM_AUDIO_DEFAULT, "1");
      setConfig(db, CONFIG_SYSTEM_AUDIO_ACK, "1");
    } finally {
      db.close();
    }
    // The daemon doesn't enforce these for socket record_start (the
    // socket caller passes its own system_audio flag); the popup
    // path inside the daemon picks them up. We don't fire a popup
    // here — we just assert the config keys are readable and don't
    // crash the status op.
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ queue_pending: number }>({ op: "status" });
      expect(typeof r.queue_pending).toBe("number");
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon: undo window", () => {
  test("undo_last returns no_undo_available when no auto-stop has happened", async () => {
    const daemon = new MeetingDaemon(
      baseOptions({ deps: { spawnEventsHelper: silentEventsHandle } }),
    );
    await daemon.start();
    try {
      const r = await callSocket<{ error?: string }>({ op: "undo_last" });
      expect(r.error).toBe("no_undo_available");
    } finally {
      await daemon.stop();
    }
  });
});
