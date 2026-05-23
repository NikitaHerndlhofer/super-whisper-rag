/**
 * Recorder lifecycle tests.
 *
 * The Swift binary is stubbed in every test: we materialise a tiny
 * bash script that pretends to be `swrag-helper record`, writes a
 * valid 200 ms WAV file to the requested --output path, emits an
 * NDJSON heartbeat on stdout, then sleeps until SIGTERM. The tests
 * exercise the TS recorder lifecycle (path generation, queue row
 * shape, discard cleanup, spawn-failure surfacing, system-audio
 * flag gating) without ever spawning the real recorder.
 *
 * Why bash and not a Bun script? Bun being on the test runner's PATH
 * is reliable inside this repo, but the stub script is `chmod +x`-ed
 * and invoked via raw `Bun.spawn` — pointing the shebang at `bash`
 * keeps the stub portable across CI configurations that haven't
 * symlinked `bun` to the expected location.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../../src/archive/open.ts";
import { spawnRecorder as realSpawnRecorder } from "../../src/mac/helper.ts";
import * as queue from "../../src/meeting/queue.ts";
import {
  buildAudioPath,
  randomShortId,
  startRecording,
  stopRecording,
} from "../../src/meeting/record.ts";

let workDir: string;
let archivePath: string;
let incomingDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-record-"));
  archivePath = join(workDir, "archive.sqlite");
  incomingDir = join(workDir, "incoming");
  // archive needs migrations to land before the first enqueue.
  const db = openArchive(archivePath, {});
  db.close();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Stub helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Write a fake `swrag-helper record` to `path`. Two variants:
 *   - `failImmediately`: print a stderr message and exit non-zero
 *     before any heartbeat / wav write. Used for the spawn-failure
 *     test.
 *   - default: write a 200 ms valid WAV to --output, emit one
 *     heartbeat to stdout (line-flushed), then sleep until SIGTERM.
 *     Exit code 0 on clean shutdown.
 *
 * The stub uses bash. We materialise the WAV header as a base64
 * blob and pipe through `base64 -D` — this avoids the `printf '\\NNN'`
 * octal-escape path which has truncate-at-NUL issues on some printf
 * implementations and was empirically flaky in the bun:test runner.
 */
function writeFakeRecorder(path: string, opts: { failImmediately?: boolean } = {}): void {
  // 44-byte RIFF/WAVE header for mono 16 kHz 16-bit PCM with 6400
  // bytes of data (200 ms). RIFF chunk size = 6436 (LE: 24 19 00 00).
  // data chunk size = 6400 (LE: 00 19 00 00).
  const wavHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x19, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    0x66, 0x6D, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x80, 0x3E, 0x00, 0x00, 0x00, 0x7D, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
    0x64, 0x61, 0x74, 0x61, 0x00, 0x19, 0x00, 0x00,
  ]);
  const wavHeaderB64 = wavHeader.toString("base64");

  const script = opts.failImmediately
    ? `#!/bin/bash
echo "fake recorder: simulated failure" 1>&2
exit 7
`
    : `#!/bin/bash
set -u
OUTPUT=""
SAW_SYSTEM_AUDIO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    record) shift ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --system-audio) SAW_SYSTEM_AUDIO="1"; shift ;;
    *) shift ;;
  esac
done
if [[ -z "$OUTPUT" ]]; then
  echo "stub: --output required" 1>&2
  exit 2
fi
if [[ -n "$SAW_SYSTEM_AUDIO" ]]; then
  echo "stub: system-audio enabled" 1>&2
fi

# Materialise the 44-byte WAV header from base64, then append 6400
# bytes of silence. Avoids printf escape-octal issues with NULs.
mkdir -p "$(dirname "$OUTPUT")"
echo '${wavHeaderB64}' | base64 -D > "$OUTPUT"
dd if=/dev/zero bs=6400 count=1 status=none >> "$OUTPUT"

# Emit one heartbeat. echo to stdout is unbuffered in bash (builtin
# writes directly via write(2)), so the parent pipe sees it
# immediately.
echo '{"frames":3200,"duration_ms":200,"level_dbfs":-20.5}'

# Wait for SIGTERM / SIGINT. We trap, then poll with short sleeps.
# Foreground \`sleep\` keeps signal delivery simple: SIGTERM arrives,
# sleep dies, bash resumes, trap fires, exit.
trap 'exit 0' TERM INT
while :; do
  sleep 0.1
done
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/**
 * Override `spawnRecorder` with one that points at our fake binary.
 * We thread it through the deps record so production code stays
 * vanilla — `spawnRecorder` itself doesn't know it's been redirected,
 * we just feed it `helperPath: <stub>` instead of the embedded asset
 * path.
 */
function fakeSpawnRecorderForBin(binPath: string): typeof realSpawnRecorder {
  return (opts) => realSpawnRecorder({ ...opts, helperPath: binPath });
}

/**
 * Provide a deterministic durationProbe so tests don't shell to
 * `afinfo` (which would be flaky on a stub-written WAV).
 */
function fakeDurationProbe(durationMs: number): (path: string) => Promise<number | null> {
  return async (_path: string) => durationMs;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("meeting/record", () => {
  test("happy path: start → heartbeat → stop produces a pending queue row", async () => {
    const bin = join(workDir, "fake-recorder.sh");
    writeFakeRecorder(bin);
    const deps = {
      archive: archivePath,
      incomingDir,
      spawnRecorder: fakeSpawnRecorderForBin(bin),
      durationProbe: fakeDurationProbe(200),
    };
    const handle = await startRecording({ label: "demo" }, deps);
    expect(existsSync(handle.audioPath)).toBe(true);
    expect(handle.audioPath.startsWith(incomingDir)).toBe(true);
    expect(handle.label).toBe("demo");
    expect(handle.captureSystemAudio).toBe(false);

    const result = await stopRecording(handle, { discard: false }, deps);
    expect(result.queueRow).not.toBeNull();
    expect(result.audioPath).toBe(handle.audioPath);
    expect(result.durationMs).toBe(200);
    expect(result.exitCode).toBe(0);

    // The wav stays on disk after a successful stop — the processor
    // is responsible for unlinking it once it's transcribed.
    expect(existsSync(handle.audioPath)).toBe(true);
    expect(statSync(handle.audioPath).size).toBeGreaterThan(44);

    // Queue row should be visible to a fresh open() so we know it
    // was persisted, not just returned.
    const queueRow = result.queueRow;
    if (queueRow == null) throw new Error("expected queueRow to be non-null");
    const db = openArchive(archivePath, {});
    try {
      const row = queue.getById(db, queueRow.id);
      expect(row).not.toBeNull();
      expect(row?.status).toBe("pending");
      expect(row?.audio_path).toBe(handle.audioPath);
      expect(row?.label).toBe("demo");
      expect(row?.duration_ms).toBe(200);
      expect(row?.captured_at).toBe(handle.startedAt);
      // captured_until is set by stopRecording → some ISO string.
      expect(row?.captured_until).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("discard path: stop({ discard: true }) unlinks the wav and creates no queue row", async () => {
    const bin = join(workDir, "fake-recorder.sh");
    writeFakeRecorder(bin);
    const deps = {
      archive: archivePath,
      incomingDir,
      spawnRecorder: fakeSpawnRecorderForBin(bin),
      durationProbe: fakeDurationProbe(200),
    };
    const handle = await startRecording({}, deps);
    expect(existsSync(handle.audioPath)).toBe(true);

    const result = await stopRecording(handle, { discard: true }, deps);
    expect(result.queueRow).toBeNull();
    expect(result.audioPath).toBeNull();
    expect(result.durationMs).toBe(0);
    expect(existsSync(handle.audioPath)).toBe(false);

    const db = openArchive(archivePath, {});
    try {
      expect(queue.countPending(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("spawn failure: stub exits non-zero before any heartbeat → start surfaces stderr", async () => {
    const bin = join(workDir, "fake-recorder-fail.sh");
    writeFakeRecorder(bin, { failImmediately: true });
    const deps = {
      archive: archivePath,
      incomingDir,
      spawnRecorder: fakeSpawnRecorderForBin(bin),
      durationProbe: fakeDurationProbe(200),
    };
    let caught: Error | null = null;
    try {
      await startRecording({}, deps);
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(caught?.message ?? "").toContain("recorder failed to start");
    // The stub wrote "simulated failure" to stderr; the start error
    // surfaces it via the stderrTail.
    expect(caught?.message ?? "").toContain("simulated failure");

    const db = openArchive(archivePath, {});
    try {
      expect(queue.countPending(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("system-audio gating: spawnRecorder receives --system-audio iff option set", async () => {
    const bin = join(workDir, "fake-recorder.sh");
    writeFakeRecorder(bin);

    // Default OFF.
    {
      const deps = {
        archive: archivePath,
        incomingDir,
        spawnRecorder: fakeSpawnRecorderForBin(bin),
        durationProbe: fakeDurationProbe(200),
      };
      const handle = await startRecording({}, deps);
      const result = await stopRecording(handle, { discard: true }, deps);
      // stub's stderr only emits "system-audio enabled" if it saw the
      // flag — absence proves we didn't pass it.
      expect(result.stderr).not.toContain("system-audio enabled");
    }

    // Explicit ON.
    {
      const deps = {
        archive: archivePath,
        incomingDir,
        spawnRecorder: fakeSpawnRecorderForBin(bin),
        durationProbe: fakeDurationProbe(200),
      };
      const handle = await startRecording({ captureSystemAudio: true }, deps);
      expect(handle.captureSystemAudio).toBe(true);
      const result = await stopRecording(handle, { discard: true }, deps);
      expect(result.stderr).toContain("system-audio enabled");
    }
  });

  test("path generation: concurrent starts produce distinct paths", async () => {
    const bin = join(workDir, "fake-recorder.sh");
    writeFakeRecorder(bin);

    // We exercise the pure helpers — buildAudioPath + randomShortId —
    // because actually starting two recorders concurrently in one
    // process would race the AVAudioEngine in production. The
    // path-generator is the layer the spec wants tested for
    // collision-resistance.
    const now = new Date("2026-05-23T10:00:00.000Z");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(buildAudioPath(incomingDir, now, randomShortId()));
    }
    // 200 distinct ids drawn from base36^8 (~2.8e12 possibilities) —
    // a collision here would be ~1 in 10^9.
    expect(seen.size).toBe(200);
  });

  test("durationProbe null is recorded as duration_ms=null on the row", async () => {
    const bin = join(workDir, "fake-recorder.sh");
    writeFakeRecorder(bin);
    const deps = {
      archive: archivePath,
      incomingDir,
      spawnRecorder: fakeSpawnRecorderForBin(bin),
      durationProbe: async (_p: string): Promise<number | null> => null,
    };
    const handle = await startRecording({}, deps);
    const result = await stopRecording(handle, { discard: false }, deps);
    expect(result.queueRow).not.toBeNull();
    expect(result.queueRow?.duration_ms).toBeNull();
    expect(result.durationMs).toBe(0); // mapped to 0 in the StoppedRecording return
  });
});
