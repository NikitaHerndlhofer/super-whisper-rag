/**
 * Popup module tests.
 *
 * v0.9.6 collapsed both banners to a single action button each — see
 * the module header in `src/meeting/popup.ts` for the rationale.
 * v0.9.7 dropped the `id=Display Label` parsing in the Swift helper,
 * so the wire literals now match the user-visible button labels
 * exactly. The two functions under test:
 *
 *   - `askStartRecording` — wire result `Record` / `timeout`. Maps
 *     `timeout` → `"skip"`.
 *   - `askStopRecording` — wire result `Stop & save` / `timeout`.
 *     Maps `timeout` → `"keep"`.
 *
 * Both real Swift-helper paths are dependency-injected via the
 * `fireNotification` option, so the suite never fires a real banner.
 */
import { describe, expect, test } from "bun:test";
import {
  askStartRecording,
  askStopRecording,
  escapeForAppleScript,
} from "../../src/meeting/popup.ts";
import type {
  FireStartRecordingNotificationOptions,
  FireStopRecordingNotificationOptions,
} from "../../src/mac/helper.ts";

describe("escapeForAppleScript", () => {
  test("escapes double-quotes", () => {
    expect(escapeForAppleScript('foo "bar" baz')).toBe('foo \\"bar\\" baz');
  });
  test("escapes backslashes before quotes", () => {
    expect(escapeForAppleScript("c:\\path\\foo")).toBe("c:\\\\path\\\\foo");
  });
});

describe("askStartRecording (v0.9.6 single-action banner)", () => {
  test("notify returning 'Record' propagates as 'record' (wire literal → daemon-facing)", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      fireNotification: async () => "Record",
    });
    expect(r).toBe("record");
  });

  test("notify returning 'timeout' maps to 'skip' (dismiss = skip)", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      fireNotification: async () => "timeout",
    });
    expect(r).toBe("skip");
  });

  test("notify throwing degrades to 'skip' (never crashes the daemon)", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      fireNotification: async () => {
        throw new Error("helper missing");
      },
    });
    expect(r).toBe("skip");
  });

  test("reason text is forwarded verbatim to the notification firer", async () => {
    type Captured = { reason: string; timeoutSeconds?: number };
    let captured: Captured | null = null;
    await askStartRecording({
      reason: 'Meeting "detected": go?',
      giveUpAfterSec: 30,
      fireNotification: async (opts: FireStartRecordingNotificationOptions) => {
        captured = { reason: opts.reason, timeoutSeconds: opts.timeoutSeconds };
        return "timeout";
      },
    });
    expect(captured).not.toBeNull();
    const c = captured as Captured | null;
    expect(c?.reason).toBe('Meeting "detected": go?');
    expect(c?.timeoutSeconds).toBe(30);
  });

  test("default giveUpAfterSec is 60 (v0.9.6 — dismiss = skip, no action on timeout)", async () => {
    let capturedTimeout: number | undefined;
    await askStartRecording({
      reason: "Test",
      fireNotification: async (opts: FireStartRecordingNotificationOptions) => {
        capturedTimeout = opts.timeoutSeconds;
        return "timeout";
      },
    });
    expect(capturedTimeout).toBe(60);
  });
});

describe("askStopRecording (v0.9.6 single-action banner)", () => {
  test("notify returning 'Stop & save' propagates as 'save' (wire literal → daemon-facing)", async () => {
    const r = await askStopRecording({
      elapsedSec: 120,
      giveUpAfterSec: 1,
      fireNotification: async () => "Stop & save",
    });
    expect(r).toBe("save");
  });

  test("notify returning 'timeout' maps to 'keep' (dismiss = keep recording)", async () => {
    const r = await askStopRecording({
      elapsedSec: 120,
      giveUpAfterSec: 1,
      fireNotification: async () => "timeout",
    });
    expect(r).toBe("keep");
  });

  test("notify throwing degrades to 'keep' (don't lose data on failure)", async () => {
    const r = await askStopRecording({
      elapsedSec: 120,
      giveUpAfterSec: 1,
      fireNotification: async () => {
        throw new Error("helper missing");
      },
    });
    expect(r).toBe("keep");
  });

  test("elapsedSec is forwarded verbatim to the notification firer", async () => {
    type Captured = { elapsedSec: number; timeoutSeconds?: number };
    let captured: Captured | null = null;
    await askStopRecording({
      elapsedSec: 305,
      giveUpAfterSec: 45,
      fireNotification: async (opts: FireStopRecordingNotificationOptions) => {
        captured = { elapsedSec: opts.elapsedSec, timeoutSeconds: opts.timeoutSeconds };
        return "Stop & save";
      },
    });
    expect(captured).not.toBeNull();
    const c = captured as Captured | null;
    expect(c?.elapsedSec).toBe(305);
    expect(c?.timeoutSeconds).toBe(45);
  });

  test("default giveUpAfterSec is 60 (symmetric with start)", async () => {
    let capturedTimeout: number | undefined;
    await askStopRecording({
      elapsedSec: 10,
      fireNotification: async (opts: FireStopRecordingNotificationOptions) => {
        capturedTimeout = opts.timeoutSeconds;
        return "timeout";
      },
    });
    expect(capturedTimeout).toBe(60);
  });
});
