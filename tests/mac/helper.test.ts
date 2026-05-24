/**
 * Integration tests for the Swift helper binary.
 *
 * These tests SKIP automatically when the vendored binary isn't on
 * disk — keeps `bun test` green on CI machines that lack the swift
 * toolchain. Local devs should run `bash scripts/build-swift-helper.sh`
 * once to materialise the binary.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FrontmostAppSchema,
  MicInUseSchema,
  PermissionsSchema,
  RecorderHeartbeatSchema,
  getFrontmostApp,
  getPermissions,
  isMicInUse,
  spawnRecorder,
} from "../../src/mac/helper.ts";

const HELPER_PATH = join(import.meta.dir, "..", "..", "vendor", "swrag-helper-darwin-universal");
const HELPER_PRESENT = existsSync(HELPER_PATH);

describe.skipIf(!HELPER_PRESENT)("mac/helper one-shots", () => {
  test("frontmost-app returns a validated shape with a non-empty bundleId", async () => {
    const result = await getFrontmostApp();
    expect(FrontmostAppSchema.safeParse(result).success).toBe(true);
    // We can't pin the exact bundleId (depends on what's frontmost
    // while the suite runs), but in a normal interactive test run
    // there's always SOMETHING frontmost.
    if (result.bundleId != null) {
      expect(result.bundleId.length).toBeGreaterThan(0);
    }
    expect(result.runningCallApps.strict).toBeArray();
    expect(result.runningCallApps.soft).toBeArray();
  });

  test("mic-in-use returns a boolean and an owners array", async () => {
    const result = await isMicInUse();
    expect(MicInUseSchema.safeParse(result).success).toBe(true);
    expect(typeof result.inUse).toBe("boolean");
    expect(Array.isArray(result.owners)).toBe(true);
  });

  test("permissions-check (no --prompt) returns the nested permission report", async () => {
    const result = await getPermissions({ prompt: false });
    expect(PermissionsSchema.safeParse(result).success).toBe(true);
    // microphone / screen_recording are tri-state enums.
    expect(["granted", "denied", "not_determined"]).toContain(result.microphone);
    expect(["granted", "denied", "not_determined"]).toContain(result.screen_recording);
    // automation should contain entries for the seven well-known browsers.
    const expectedBrowsers = [
      "com.apple.Safari",
      "com.google.Chrome",
      "com.brave.Browser",
      "company.thebrowser.Browser",
      "com.vivaldi.Vivaldi",
      "com.microsoft.edgemac",
      "ai.perplexity.comet",
    ];
    for (const b of expectedBrowsers) {
      const state = result.automation[b];
      expect(state).toBeDefined();
      // Narrow off undefined for the contains check (TS doesn't propagate
      // the toBeDefined assertion); the previous line already asserted.
      expect(["granted", "denied", "not_determined", "not_installed"]).toContain(state ?? "");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* spawnRecorder — real-binary integration                                    */
/* -------------------------------------------------------------------------- */

/**
 * These tests exercise the real Swift recorder against the host's
 * microphone. They DO NOT enable `--system-audio` because that would
 * require Screen Recording permission and the system would prompt
 * the user (or fail silently in CI). The mic path is the load-bearing
 * VPIO chain we need confidence in; system-audio mixing is covered by
 * code review + the manual smoke test in docs/phase3-recorder-smoke.md.
 *
 * Skipped automatically when the vendored binary isn't present.
 */
describe.skipIf(!HELPER_PRESENT)("spawnRecorder (real binary)", () => {
  test("writes a non-zero WAV with a valid header within ~2 s and yields a heartbeat", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "swrag-rec-"));
    const outputPath = join(tmp, "test.wav");
    const handle = spawnRecorder({
      outputPath,
      captureSystemAudio: false,
      helperPath: HELPER_PATH,
    });
    try {
      // Wait for the first heartbeat (or a 2 s ceiling).
      const ev = await firstHeartbeat(handle.events, 2_500);
      expect(ev).not.toBeNull();
      const parsed = RecorderHeartbeatSchema.safeParse(ev);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.duration_ms ?? -1).toBeGreaterThanOrEqual(0);
    } finally {
      const stopResult = await handle.stop();
      expect(stopResult.exitCode).toBe(0);
    }
    // After clean shutdown the WAV exists and has > 44 bytes (header
    // alone is 44; any real capture adds samples on top).
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(44);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("stop({ discard: true }) deletes the wav after the helper exits", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "swrag-rec-"));
    const outputPath = join(tmp, "test-discard.wav");
    const handle = spawnRecorder({
      outputPath,
      captureSystemAudio: false,
      helperPath: HELPER_PATH,
    });
    await firstHeartbeat(handle.events, 2_500);
    const stopResult = await handle.stop({ discard: true });
    expect(stopResult.exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(
    "parent-death recovery: stdout pipe close triggers graceful shutdown and finalises wav",
    async () => {
      // Regression for the SIGKILL-parent bug. Without the fix, the
      // helper's next heartbeat write after the parent dies receives
      // SIGPIPE, the default action (terminate) fires before the Swift
      // shutdown path can run, and the wav is left with riff_size /
      // data chunk size pointing at zero bytes — afinfo reports "0 sec"
      // even though the actual samples are physically on disk.
      //
      // With the fix:
      //   * SIGPIPE is ignored process-wide inside the recorder.
      //   * FileHandle.write(contentsOf:) throws EPIPE.
      //   * tryPrintJSON returns false → emitHeartbeat dispatches
      //     shutdown() on .main.
      //   * shutdown() finalises the wav header and exits 0.
      //
      // We simulate parent-death by spawning the recorder directly and
      // calling proc.stdout.cancel() — this closes the parent's read
      // end of the stdout pipe, which is what would happen if the
      // parent died and the kernel reclaimed its fds.
      const tmp = mkdtempSync(join(tmpdir(), "swrag-rec-"));
      const outputPath = join(tmp, "test-parent-death.wav");
      try {
        const proc = Bun.spawn([HELPER_PATH, "record", "--output", outputPath], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        // Read until we see the first heartbeat line. That confirms
        // VPIO is up and the helper has started recording — closing
        // the pipe before the first heartbeat would race against
        // setup-time errors that we don't want to mistake for the
        // parent-death path.
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let leftover = "";
        // 5 s ceiling so a hung VPIO doesn't hang the test forever.
        const startedAt = Date.now();
        let sawHeartbeat = false;
        while (Date.now() - startedAt < 5_000) {
          const { value, done } = await reader.read();
          if (done) break;
          leftover += decoder.decode(value, { stream: true });
          if (leftover.includes("\n")) {
            sawHeartbeat = true;
            break;
          }
        }
        expect(sawHeartbeat).toBe(true);
        // Release + cancel the reader. This closes the parent's read
        // end of the pipe. The recorder's next stdout write will EPIPE.
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
        try {
          await proc.stdout.cancel();
        } catch {
          // best-effort; the FD is what matters, not the JS wrapper
        }
        // Wait up to 4 s for the helper to detect EPIPE on its next
        // heartbeat write (heartbeats fire every ~1 s) and run shutdown.
        const exitPromise = proc.exited;
        const timeoutPromise = new Promise<number>((resolve) => {
          setTimeout(() => resolve(-1), 4_000);
        });
        const exitCode = await Promise.race([exitPromise, timeoutPromise]);
        // Belt-and-braces: if the helper somehow hung, SIGTERM it.
        // The assertion below distinguishes "fix works" (exit 0 from
        // graceful shutdown) from "we had to clobber it" (-1 timeout).
        if (exitCode === -1) {
          try {
            proc.kill("SIGTERM");
          } catch {
            // already dead
          }
          await proc.exited;
        }
        expect(exitCode).toBe(0);
        // The wav must be present, larger than the 44-byte minimum
        // header, and walk cleanly as a RIFF/WAVE with a data chunk
        // whose declared size matches the physical bytes after it.
        // Without the fix, riff_size / data chunk size were both stale
        // (0 bytes audio) even though the file was 96 KB on disk.
        expect(existsSync(outputPath)).toBe(true);
        const size = statSync(outputPath).size;
        expect(size).toBeGreaterThan(44);
        const buf = readFileSync(outputPath);
        expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(buf.subarray(8, 12).toString("ascii")).toBe("WAVE");
        // Walk top-level chunks; expect a `data` chunk whose declared
        // size matches the trailing bytes in the file.
        let off = 12;
        let foundData = false;
        while (off + 8 <= size) {
          const tag = buf.subarray(off, off + 4).toString("ascii");
          const sz = buf.readUInt32LE(off + 4);
          if (tag === "data") {
            const expectedDataBytes = size - (off + 8);
            expect(sz).toBe(expectedDataBytes);
            foundData = true;
            break;
          }
          off += 8 + sz + (sz % 2);
        }
        expect(foundData).toBe(true);
        // RIFF chunk size in the header should also be file_size - 8.
        expect(buf.readUInt32LE(4)).toBe(size - 8);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

/**
 * Helper: pull the first heartbeat off the iterator within a hard
 * timeout, returning null on timeout.
 */
async function firstHeartbeat(
  events: AsyncIterable<{ frames: number; duration_ms: number; level_dbfs: number }>,
  timeoutMs: number,
): Promise<{ frames: number; duration_ms: number; level_dbfs: number } | null> {
  const iter = events[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const result = await Promise.race([iter.next(), timeout]);
    if (result == null) return null;
    if (result.done) return null;
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
