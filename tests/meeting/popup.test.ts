/**
 * Popup module tests.
 *
 * The real osascript is never invoked — every test passes an
 * injected exec stub. We focus on:
 *
 *   - Output parsing covers the three osascript states (button,
 *     timeout, dismiss).
 *   - The reason text round-trips through the AppleScript escape
 *     layer without breaking the inner double-quoted string.
 *   - Notification path swallows non-zero exit codes (cosmetic
 *     failures must never crash the caller).
 */
import { describe, expect, test } from "bun:test";
import {
  askStartRecording,
  escapeForAppleScript,
  notifyAutoStopped,
  parseDialogOutput,
} from "../../src/meeting/popup.ts";

describe("parseDialogOutput", () => {
  test("regular click: button:Record, gave up:false", () => {
    const r = parseDialogOutput("button returned:Record, gave up:false\n");
    expect(r.button).toBe("Record");
    expect(r.gaveUp).toBe(false);
  });

  test("timeout: gave up:true with empty button", () => {
    const r = parseDialogOutput("button returned:, gave up:true\n");
    expect(r.button).toBe("");
    expect(r.gaveUp).toBe(true);
  });

  test("dismissed via cmd-W: empty button + false", () => {
    const r = parseDialogOutput("button returned:, gave up:false\n");
    expect(r.button).toBe("");
    expect(r.gaveUp).toBe(false);
  });

  test("Skip click maps to skip-button", () => {
    const r = parseDialogOutput("button returned:Skip, gave up:false");
    expect(r.button).toBe("Skip");
    expect(r.gaveUp).toBe(false);
  });
});

describe("escapeForAppleScript", () => {
  test("escapes double-quotes", () => {
    expect(escapeForAppleScript('foo "bar" baz')).toBe('foo \\"bar\\" baz');
  });
  test("escapes backslashes before quotes", () => {
    expect(escapeForAppleScript("c:\\path\\foo")).toBe("c:\\\\path\\\\foo");
  });
});

describe("askStartRecording", () => {
  test("Record click → 'record'", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      exec: async () => ({
        exitCode: 0,
        stdout: "button returned:Record, gave up:false\n",
        stderr: "",
      }),
    });
    expect(r).toBe("record");
  });

  test("Skip click → 'skip'", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      exec: async () => ({
        exitCode: 0,
        stdout: "button returned:Skip, gave up:false\n",
        stderr: "",
      }),
    });
    expect(r).toBe("skip");
  });

  test("timeout → 'timeout'", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      exec: async () => ({
        exitCode: 0,
        stdout: "button returned:, gave up:true\n",
        stderr: "",
      }),
    });
    expect(r).toBe("timeout");
  });

  test("osascript User canceled exit → 'skip' (no exception)", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      exec: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "execution error: User canceled. (-128)",
      }),
    });
    expect(r).toBe("skip");
  });

  test("osascript non-canceled exit → 'skip' (degrades gracefully)", async () => {
    const r = await askStartRecording({
      reason: "Test",
      giveUpAfterSec: 1,
      exec: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "some other error",
      }),
    });
    expect(r).toBe("skip");
  });

  test("reason text with quotes is escaped in the osascript command", async () => {
    let capturedScript: string | null = null;
    await askStartRecording({
      reason: 'Meeting "detected": go?',
      giveUpAfterSec: 1,
      exec: async (cmd) => {
        capturedScript = cmd[cmd.length - 1] ?? null;
        return { exitCode: 0, stdout: "button returned:Skip, gave up:false\n", stderr: "" };
      },
    });
    expect(capturedScript).not.toBeNull();
    // The inner double-quotes of the dialog string must be escaped.
    expect(capturedScript ?? "").toContain('Meeting \\"detected\\": go?');
  });

  test("default giveUpAfterSec passes 90 to osascript", async () => {
    let capturedScript: string | null = null;
    await askStartRecording({
      reason: "Test",
      exec: async (cmd) => {
        capturedScript = cmd[cmd.length - 1] ?? null;
        return { exitCode: 0, stdout: "button returned:Skip, gave up:false\n", stderr: "" };
      },
    });
    expect(capturedScript ?? "").toContain("giving up after 90");
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
});
