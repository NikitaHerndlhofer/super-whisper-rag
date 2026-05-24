/**
 * Popup module tests.
 *
 * v0.9.0 split the popup into two code paths:
 *   - `askStartRecording` — now a thin wrapper around
 *     `fireStartRecordingNotification` (UNUserNotificationCenter via
 *     the Swift helper's `notify` subcommand). Tests inject a fake
 *     `fireNotification` and assert the daemon-visible contract:
 *     map any of the helper-side outputs to the right `StartChoice`.
 *   - `notifyAutoStopped` — still uses `osascript display
 *     notification` (single-line, no action buttons). Tests inject
 *     an exec stub and assert the AppleScript command shape +
 *     escaping behaviour.
 *
 * The real Swift helper / osascript are never invoked from this
 * suite — both are dependency-injected.
 */
import { describe, expect, test } from "bun:test";
import {
  askStartRecording,
  escapeForAppleScript,
  notifyAutoStopped,
} from "../../src/meeting/popup.ts";

describe("escapeForAppleScript", () => {
  test("escapes double-quotes", () => {
    expect(escapeForAppleScript('foo "bar" baz')).toBe('foo \\"bar\\" baz');
  });
  test("escapes backslashes before quotes", () => {
    expect(escapeForAppleScript("c:\\path\\foo")).toBe("c:\\\\path\\\\foo");
  });
});

describe("askStartRecording (v0.9.0 banner)", () => {
  test("notify returning 'record' propagates as 'record'", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      fireNotification: async () => "record",
    });
    expect(r).toBe("record");
  });

  test("notify returning 'skip' propagates as 'skip'", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      fireNotification: async () => "skip",
    });
    expect(r).toBe("skip");
  });

  test("notify returning 'timeout' propagates as 'timeout'", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      fireNotification: async () => "timeout",
    });
    expect(r).toBe("timeout");
  });

  test("notify throwing degrades to 'timeout' (never crashes the daemon)", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      fireNotification: async () => {
        throw new Error("helper missing");
      },
    });
    expect(r).toBe("timeout");
  });

  test("reason text is forwarded verbatim to the notification firer", async () => {
    type Captured = { reason: string; timeoutSeconds?: number };
    let captured: Captured | null = null;
    await askStartRecording({
      reason: 'Meeting "detected": go?',
      giveUpAfterSec: 30,
      fireNotification: async (opts) => {
        captured = { reason: opts.reason, timeoutSeconds: opts.timeoutSeconds };
        return "skip";
      },
    });
    expect(captured).not.toBeNull();
    const c = captured as Captured | null;
    expect(c?.reason).toBe('Meeting "detected": go?');
    expect(c?.timeoutSeconds).toBe(30);
  });

  test("default giveUpAfterSec is 90", async () => {
    let capturedTimeout: number | undefined;
    await askStartRecording({
      reason: "Test",
      fireNotification: async (opts) => {
        capturedTimeout = opts.timeoutSeconds;
        return "skip";
      },
    });
    expect(capturedTimeout).toBe(90);
  });
});

describe("notifyAutoStopped", () => {
  test("emits a display notification osascript call", async () => {
    const calls: string[][] = [];
    await notifyAutoStopped({
      wavPath: "/tmp/x.wav",
      queueRowId: 42,
      exec: async (cmd) => {
        calls.push([...cmd]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe("osascript");
    const script = calls[0]?.[calls[0]?.length - 1] ?? "";
    expect(script).toContain("display notification");
    expect(script).toContain("queue id 42");
    expect(script).toContain("x.wav");
  });

  test("non-zero exit is swallowed, not thrown", async () => {
    let caught: Error | null = null;
    try {
      await notifyAutoStopped({
        wavPath: "/tmp/x.wav",
        queueRowId: 1,
        exec: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
      });
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).toBeNull();
  });

  test("exec throwing is swallowed, not propagated", async () => {
    let caught: Error | null = null;
    try {
      await notifyAutoStopped({
        wavPath: "/tmp/x.wav",
        queueRowId: 1,
        exec: async () => {
          throw new Error("exec failure");
        },
      });
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).toBeNull();
  });

  test("wavPath basename is rendered with escaped quotes if necessary", async () => {
    let script = "";
    await notifyAutoStopped({
      wavPath: '/tmp/strange "quoted".wav',
      queueRowId: 7,
      exec: async (cmd) => {
        script = cmd[cmd.length - 1] ?? "";
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(script).toContain('strange \\"quoted\\".wav');
  });
});
