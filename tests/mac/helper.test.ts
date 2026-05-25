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
  fireStartRecordingNotification,
  fireStopRecordingNotification,
  getFrontmostApp,
  getPermissions,
  isMicInUse,
  spawnRecorder,
} from "../../src/mac/helper.ts";

// v0.9.0+: helper ships as a code-signed .app bundle. Tests spawn
// the inner binary directly — Foundation still resolves the bundle
// context because the parent directories form the .app structure.
const HELPER_APP = join(import.meta.dir, "..", "..", "vendor", "swrag-helper.app");
const HELPER_PATH = join(HELPER_APP, "Contents", "MacOS", "swrag-helper");
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

  test(
    "mic-in-use reports owners including ai.swrag.helper while recorder is running (v0.9.8 + v0.9.9)",
    async () => {
      // Regression for the v0.9.7 silent failure: owners were always
      // empty on this machine because the bundle-id resolution went
      // through NSRunningApplication(processIdentifier:), which
      // returns nil for daemon-style processes. v0.9.8 resolves bundle
      // ids directly via kAudioProcessPropertyBundleID. With the fix,
      // any process that opens the mic shows up in owners — including
      // our own recorder, which is what enables the
      // recorder-PID-masking filter in detect.ts.
      //
      // v0.9.9 changes the underlying enumeration to per-process
      // (kAudioHardwarePropertyProcessObjectList + kAudioProcessProperty
      // IsRunningInput) instead of the device-level OR-aggregate.
      // `inUse` is now derived from `owners.count > 0` rather than
      // an independent device read. This test still asserts the
      // same external contract: while the recorder runs, `inUse` is
      // `true` and `owners` contains our helper bundle id. A
      // regression in the new enumeration (process list returning
      // empty, or our recorder failing to flip its
      // IsRunningInput=true) would break this assertion.
      const tmp = mkdtempSync(join(tmpdir(), "swrag-rec-"));
      const outputPath = join(tmp, "owners-probe.wav");
      const handle = spawnRecorder({
        outputPath,
        captureSystemAudio: false,
        helperPath: HELPER_PATH,
      });
      try {
        // Wait for the first heartbeat so we know the mic is open.
        const ev = await firstHeartbeat(handle.events, 2_500);
        expect(ev).not.toBeNull();
        const probe = await isMicInUse();
        expect(probe.inUse).toBe(true);
        // On macOS 14.4+, owners MUST include ai.swrag.helper while
        // our recorder is active. Below 14.4 the helper documents
        // owners as best-effort (empty), but our LSMinimumSystemVersion
        // is 13.0 — so older OSes are out of scope for the test
        // assertion. If `owners` is empty here, either we're running
        // on macOS < 14.4 (the entire fix is N/A) or the bundle-id
        // query regressed.
        expect(probe.owners).toContain("ai.swrag.helper");
      } finally {
        await handle.stop({ discard: true });
      }
      rmSync(tmp, { recursive: true, force: true });
    },
    10_000,
  );

  test("permissions-check (no --prompt) returns the nested permission report", async () => {
    const result = await getPermissions({ prompt: false });
    expect(PermissionsSchema.safeParse(result).success).toBe(true);
    // microphone / screen_recording are tri-state enums.
    expect(["granted", "denied", "not_determined"]).toContain(result.microphone);
    expect(["granted", "denied", "not_determined"]).toContain(result.screen_recording);
    // notifications carries a four-state enum starting in v0.9.0.
    expect(["granted", "denied", "not_determined", "provisional"]).toContain(result.notifications);
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

/* -------------------------------------------------------------------------- */
/* fireStartRecordingNotification — unit-level wrapper coverage              */
/* -------------------------------------------------------------------------- */

/**
 * The integration story for `notify` is hard to fully automate: a
 * real banner requires user interaction or a UI test runner. These
 * tests exercise the wrapper's parsing + degradation logic against a
 * stubbed exec — we run an integration smoke against the real helper
 * binary in the next block, behind the `--actions` shape check.
 */
describe("fireStartRecordingNotification (stubbed exec)", () => {
  test("stdout 'Record' → 'Record'", async () => {
    const r = await fireStartRecordingNotification({
      reason: "Test",
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "Record\n", stderr: "" }),
    });
    expect(r).toBe("Record");
  });

  // v0.9.6 dropped the explicit "skip" action button — the start
  // banner is now single-action (Record). Anything other than
  // "Record" or "timeout" degrades to "timeout" via the schema
  // validator; we assert that fallback here using the legacy literal
  // so a future regression that re-introduces a "skip" wire payload
  // can't accidentally pass through unmapped.
  test("stdout 'skip' (legacy) → 'timeout' (single-action banner)", async () => {
    const r = await fireStartRecordingNotification({
      reason: "Test",
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "skip\n", stderr: "" }),
    });
    expect(r).toBe("timeout");
  });

  // v0.9.7 dropped the helper-side `.lowercased()` normalisation on
  // the wire payload. The schema literal is now case-sensitive: an
  // accidental lowercase `record` (e.g. from a stale v0.9.6 helper
  // binary that's still in the user's temp cache) must degrade to
  // "timeout" rather than be silently accepted as the affirmative
  // path — otherwise we'd start recording without the user actually
  // clicking the button.
  test("stdout 'record' (legacy lowercased) → 'timeout' (v0.9.7 wire literal is case-sensitive)", async () => {
    const r = await fireStartRecordingNotification({
      reason: "Test",
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "record\n", stderr: "" }),
    });
    expect(r).toBe("timeout");
  });

  test("stdout 'timeout' → 'timeout'", async () => {
    const r = await fireStartRecordingNotification({
      reason: "Test",
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "timeout\n", stderr: "" }),
    });
    expect(r).toBe("timeout");
  });

  test("non-zero exit degrades to 'timeout' rather than throwing", async () => {
    const r = await fireStartRecordingNotification({
      reason: "Test",
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 4, stdout: "", stderr: "authorization denied" }),
    });
    expect(r).toBe("timeout");
  });

  test("unexpected stdout shape degrades to 'timeout'", async () => {
    const r = await fireStartRecordingNotification({
      reason: "Test",
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "explode\n", stderr: "" }),
    });
    expect(r).toBe("timeout");
  });

  test("spawn-level error degrades to 'timeout'", async () => {
    const r = await fireStartRecordingNotification({
      reason: "Test",
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(r).toBe("timeout");
  });

  test("argv shape: notify subcommand + single action + default-action + timeout", async () => {
    let captured: string[] = [];
    await fireStartRecordingNotification({
      reason: 'Zoom is in a meeting — "ack"?',
      timeoutSeconds: 12,
      helperPath: "/tmp/fake-helper",
      exec: async (cmd) => {
        captured = [...cmd];
        return { exitCode: 0, stdout: "Record\n", stderr: "" };
      },
    });
    expect(captured[0]).toBe("/tmp/fake-helper");
    expect(captured[1]).toBe("notify");
    expect(captured).toContain("--actions");
    const actionsIdx = captured.indexOf("--actions");
    // v0.9.7: single-action banner. The action label `Record`
    // doubles as the wire-side identifier — helper echoes it
    // verbatim on click. (v0.9.6 used `id=Display Label` parsing;
    // macOS surfaced the raw `id=Label` string in the button on
    // some systems, so we collapsed back to a single string.)
    expect(captured[actionsIdx + 1]).toBe("Record");
    const defaultIdx = captured.indexOf("--default-action");
    expect(captured[defaultIdx + 1]).toBe("Record");
    const timeoutIdx = captured.indexOf("--timeout");
    expect(captured[timeoutIdx + 1]).toBe("12");
    const bodyIdx = captured.indexOf("--body");
    expect(captured[bodyIdx + 1]).toBe('Zoom is in a meeting — "ack"?');
  });
});

/* -------------------------------------------------------------------------- */
/* fireStartRecordingNotification — smoke against real helper                 */
/* -------------------------------------------------------------------------- */

/**
 * Real-binary smoke for the notify subcommand. We can't assert on
 * the user clicking a button (no UI test runner), but we CAN assert
 * that the binary accepts the argv shape, runs to the timeout, and
 * emits a valid result on stdout. Run with a very short timeout so
 * the suite completes in ~1.5 s even when the banner is dismissed.
 *
 * Skipped when the binary isn't present (CI without swift toolchain).
 * Skipped when SWRAG_SKIP_NOTIFY_SMOKE=1 — set this in environments
 * where the helper's notification authorization state is unknown and
 * an auth-denied result would noisy up the suite (e.g. local dev
 * where the user has never granted notification permission to the
 * v0.9.0 bundle yet).
 */
const NOTIFY_SMOKE_DISABLED = process.env.SWRAG_SKIP_NOTIFY_SMOKE === "1";

describe.skipIf(!HELPER_PRESENT || NOTIFY_SMOKE_DISABLED)(
  "fireStartRecordingNotification (real binary)",
  () => {
    test(
      "real helper accepts notify argv, runs to short timeout, emits a valid result",
      async () => {
        const r = await fireStartRecordingNotification({
          reason: "swrag test banner — ignore",
          timeoutSeconds: 2,
          helperPath: HELPER_PATH,
        });
        // Acceptable outcomes:
        //   * "timeout" — banner auto-dismissed (no user click).
        //   * "Record" — the suite runner happened to click.
        //   * Auth-denied paths degrade to "timeout" via the wrapper,
        //     same as a true timeout — they're equivalent from the
        //     daemon's POV.
        // (v0.9.6 dropped the legacy "skip" wire payload; v0.9.7
        // dropped the helper-side lowercasing, so the affirmative
        // wire literal is now case-sensitive `Record`.)
        expect(["Record", "timeout"]).toContain(r);
      },
      10_000,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* fireStopRecordingNotification — unit-level wrapper coverage (v0.9.6)      */
/* -------------------------------------------------------------------------- */

/**
 * Symmetric with the start-notification block. The stop banner is
 * single-action (`Stop & save`) — anything other than `Stop & save`
 * / `timeout` on stdout degrades to `"timeout"`. The daemon's
 * `popup.ts::askStopRecording` then maps `"timeout"` to the
 * user-facing `"keep"`.
 */
describe("fireStopRecordingNotification (stubbed exec)", () => {
  test("stdout 'Stop & save' → 'Stop & save'", async () => {
    const r = await fireStopRecordingNotification({
      elapsedSec: 65,
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "Stop & save\n", stderr: "" }),
    });
    expect(r).toBe("Stop & save");
  });

  test("stdout 'timeout' → 'timeout'", async () => {
    const r = await fireStopRecordingNotification({
      elapsedSec: 65,
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "timeout\n", stderr: "" }),
    });
    expect(r).toBe("timeout");
  });

  test("legacy 'discard' wire payload (single-action) degrades to 'timeout'", async () => {
    // v0.9.6 dropped the Stop-&-discard button from the banner.
    // If a future regression re-emits "discard" on stdout, the
    // schema must reject it so the daemon never accidentally
    // discards a recording on a stale wire payload.
    const r = await fireStopRecordingNotification({
      elapsedSec: 65,
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "discard\n", stderr: "" }),
    });
    expect(r).toBe("timeout");
  });

  test("legacy 'save' (v0.9.6 lowercased wire id) degrades to 'timeout'", async () => {
    // v0.9.7 dropped the helper-side `.lowercased()` normalisation
    // and the `id=Display Label` parsing — the wire literal is now
    // the exact action label (`Stop & save`). A stale helper binary
    // emitting the v0.9.6 lowercased id `save` must NOT slip through
    // as the affirmative path: degrade to "timeout" so the daemon
    // keeps recording (the next mic edge will re-fire the banner).
    const r = await fireStopRecordingNotification({
      elapsedSec: 65,
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 0, stdout: "save\n", stderr: "" }),
    });
    expect(r).toBe("timeout");
  });

  test("non-zero exit degrades to 'timeout' rather than throwing", async () => {
    const r = await fireStopRecordingNotification({
      elapsedSec: 65,
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => ({ exitCode: 4, stdout: "", stderr: "authorization denied" }),
    });
    expect(r).toBe("timeout");
  });

  test("spawn-level error degrades to 'timeout'", async () => {
    const r = await fireStopRecordingNotification({
      elapsedSec: 65,
      timeoutSeconds: 5,
      helperPath: "/usr/bin/true",
      exec: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(r).toBe("timeout");
  });

  test("argv shape: single action `Stop & save`, default-action `Stop & save`, elapsed in body", async () => {
    let captured: string[] = [];
    await fireStopRecordingNotification({
      elapsedSec: 125, // 2:05
      timeoutSeconds: 7,
      helperPath: "/tmp/fake-helper",
      exec: async (cmd) => {
        captured = [...cmd];
        return { exitCode: 0, stdout: "Stop & save\n", stderr: "" };
      },
    });
    expect(captured[0]).toBe("/tmp/fake-helper");
    expect(captured[1]).toBe("notify");
    const actionsIdx = captured.indexOf("--actions");
    // v0.9.7: action label doubles as wire identifier (no `=` split).
    // `Bun.spawn` passes argv as an array, so `&` and spaces in
    // `Stop & save` round-trip cleanly without shell escaping.
    expect(captured[actionsIdx + 1]).toBe("Stop & save");
    const defaultIdx = captured.indexOf("--default-action");
    expect(captured[defaultIdx + 1]).toBe("Stop & save");
    const timeoutIdx = captured.indexOf("--timeout");
    expect(captured[timeoutIdx + 1]).toBe("7");
    const bodyIdx = captured.indexOf("--body");
    // 125 s renders as 2:05.
    expect(captured[bodyIdx + 1]).toContain("2:05");
    const titleIdx = captured.indexOf("--title");
    expect(captured[titleIdx + 1]).toBe("Meeting ended");
  });
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
