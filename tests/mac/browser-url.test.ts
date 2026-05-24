/**
 * Tests for `src/mac/browser-url.ts`.
 *
 * The real `osascript` call is mocked via the `spawn` injection hook so
 * these tests run on any machine — no front browser, no Apple Events
 * permission, no flake.
 *
 * Covered:
 *   - bundle-id-to-dialect dispatch table (the six known browsers)
 *   - `isKnownBrowser` discriminator
 *   - `getBrowserUrl` returns the trimmed stdout on a successful call
 *   - failure modes all map to `null` (per the soft-signal contract):
 *       · unknown bundle id (no spawn fired)
 *       · non-zero exit code
 *       · "missing value" stdout (front window without a tab)
 *       · empty stdout
 *       · spawn throws synchronously (osascript missing on PATH)
 *   - the correct AppleScript dialect ends up on the command line
 */
import { describe, expect, test } from "bun:test";
import {
  BROWSER_OSASCRIPT_DIALECTS,
  getBrowserUrl,
  isKnownBrowser,
} from "../../src/mac/browser-url.ts";

/* -------------------------------------------------------------------------- */
/* spawn mock                                                                 */
/* -------------------------------------------------------------------------- */

interface MockProcResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

interface SpawnCall {
  cmd: readonly string[];
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (body == null) {
    // Response(text).body is non-null on all supported runtimes; this
    // branch exists purely to satisfy biome's no-non-null-assertion rule.
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }
  return body;
}

function makeSpawnMock(result: MockProcResult | (() => MockProcResult)) {
  const calls: SpawnCall[] = [];
  const spawn = ((cmd: readonly string[]) => {
    calls.push({ cmd });
    const r = typeof result === "function" ? result() : result;
    return {
      stdout: streamFrom(r.stdout),
      stderr: streamFrom(r.stderr ?? ""),
      exited: Promise.resolve(r.exitCode),
      kill: () => {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawn, calls };
}

function makeThrowingSpawn(err: Error) {
  const calls: SpawnCall[] = [];
  const spawn = ((cmd: readonly string[]) => {
    calls.push({ cmd });
    throw err;
  }) as unknown as typeof Bun.spawn;
  return { spawn, calls };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("BROWSER_OSASCRIPT_DIALECTS dispatch table", () => {
  test("contains the seven well-known browser bundle IDs", () => {
    expect(Object.keys(BROWSER_OSASCRIPT_DIALECTS).sort()).toEqual(
      [
        "ai.perplexity.comet",
        "com.apple.Safari",
        "com.brave.Browser",
        "com.google.Chrome",
        "com.microsoft.edgemac",
        "com.vivaldi.Vivaldi",
        "company.thebrowser.Browser",
      ].sort(),
    );
  });

  test("Safari uses `current tab` (it's the only one that does)", () => {
    expect(BROWSER_OSASCRIPT_DIALECTS["com.apple.Safari"].script).toContain("current tab");
    expect(BROWSER_OSASCRIPT_DIALECTS["com.apple.Safari"].appName).toBe("Safari");
  });

  test("Chromium-family browsers use `active tab` (Chrome / Brave / Vivaldi / Edge / Arc / Comet)", () => {
    for (const bid of [
      "com.google.Chrome",
      "com.brave.Browser",
      "com.vivaldi.Vivaldi",
      "com.microsoft.edgemac",
      "company.thebrowser.Browser",
      "ai.perplexity.comet",
    ] as const) {
      expect(BROWSER_OSASCRIPT_DIALECTS[bid].script).toContain("active tab");
    }
  });

  test("each dialect targets its app by display name in the `tell application` block", () => {
    const expectedNames: Record<keyof typeof BROWSER_OSASCRIPT_DIALECTS, string> = {
      "com.apple.Safari": "Safari",
      "com.google.Chrome": "Google Chrome",
      "com.brave.Browser": "Brave Browser",
      "company.thebrowser.Browser": "Arc",
      "com.vivaldi.Vivaldi": "Vivaldi",
      "com.microsoft.edgemac": "Microsoft Edge",
      "ai.perplexity.comet": "Comet",
    };
    for (const [bid, expectedName] of Object.entries(expectedNames)) {
      const dialect = BROWSER_OSASCRIPT_DIALECTS[bid as keyof typeof BROWSER_OSASCRIPT_DIALECTS];
      // `toBe` is overload-narrowed off `dialect.appName`'s literal-union
      // type; expectedName is the same value coming from the parallel
      // record, so the cast is sound.
      expect(dialect.appName as string).toBe(expectedName);
      expect(dialect.script).toContain(`tell application "${expectedName}"`);
    }
  });
});

describe("isKnownBrowser", () => {
  test("recognises all seven dispatch-table keys", () => {
    for (const bid of Object.keys(BROWSER_OSASCRIPT_DIALECTS)) {
      expect(isKnownBrowser(bid)).toBe(true);
    }
  });

  test("rejects anything not in the table", () => {
    expect(isKnownBrowser("com.apple.Notes")).toBe(false);
    expect(isKnownBrowser("us.zoom.xos")).toBe(false);
    expect(isKnownBrowser("")).toBe(false);
  });
});

describe("getBrowserUrl", () => {
  test("returns the trimmed stdout when osascript succeeds", async () => {
    const { spawn, calls } = makeSpawnMock({
      stdout: "https://meet.google.com/abc-defg-hij\n",
      exitCode: 0,
    });
    const url = await getBrowserUrl("com.google.Chrome", { spawn });
    expect(url).toBe("https://meet.google.com/abc-defg-hij");
    expect(calls).toHaveLength(1);
    // The dispatch routed Chrome to the Chromium-family `active tab` script.
    expect(calls[0]?.cmd[0]).toBe("osascript");
    expect(calls[0]?.cmd[1]).toBe("-e");
    expect(calls[0]?.cmd[2]).toContain("Google Chrome");
    expect(calls[0]?.cmd[2]).toContain("active tab");
  });

  test("uses Safari's `current tab` dialect when bundle id is Safari", async () => {
    const { spawn, calls } = makeSpawnMock({
      stdout: "https://example.com/\n",
      exitCode: 0,
    });
    await getBrowserUrl("com.apple.Safari", { spawn });
    expect(calls[0]?.cmd[2]).toContain("Safari");
    expect(calls[0]?.cmd[2]).toContain("current tab");
    // Sanity: should NOT contain `active tab` (Chromium dialect).
    expect(calls[0]?.cmd[2]).not.toContain("active tab");
  });

  test("Comet (ai.perplexity.comet) dispatches through the Chrome-style `active tab` osascript", async () => {
    const { spawn, calls } = makeSpawnMock({
      stdout: "https://meet.google.com/abc-defg-hij\n",
      exitCode: 0,
    });
    const url = await getBrowserUrl("ai.perplexity.comet", { spawn });
    expect(url).toBe("https://meet.google.com/abc-defg-hij");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd[0]).toBe("osascript");
    expect(calls[0]?.cmd[1]).toBe("-e");
    // The dispatch routed Comet to the Chromium-family `active tab`
    // script targeting `tell application "Comet"`.
    expect(calls[0]?.cmd[2]).toContain('tell application "Comet"');
    expect(calls[0]?.cmd[2]).toContain("active tab");
    expect(calls[0]?.cmd[2]).not.toContain("current tab");
  });

  test("returns null without invoking spawn when bundle is unknown", async () => {
    const { spawn, calls } = makeSpawnMock({ stdout: "", exitCode: 0 });
    const url = await getBrowserUrl("com.apple.Notes", { spawn });
    expect(url).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("returns null when osascript exits non-zero (Apple Events denied)", async () => {
    const { spawn } = makeSpawnMock({
      stdout: "",
      stderr: "execution error: Not authorised to send Apple events to Google Chrome. (-1743)\n",
      exitCode: 1,
    });
    const url = await getBrowserUrl("com.google.Chrome", { spawn });
    expect(url).toBeNull();
  });

  test("returns null when osascript prints `missing value` (no active tab)", async () => {
    const { spawn } = makeSpawnMock({ stdout: "missing value\n", exitCode: 0 });
    const url = await getBrowserUrl("com.google.Chrome", { spawn });
    expect(url).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const { spawn } = makeSpawnMock({ stdout: "", exitCode: 0 });
    const url = await getBrowserUrl("com.google.Chrome", { spawn });
    expect(url).toBeNull();
  });

  test("returns null when spawn throws synchronously (osascript missing)", async () => {
    const { spawn } = makeThrowingSpawn(new Error("ENOENT: osascript"));
    const url = await getBrowserUrl("com.google.Chrome", { spawn });
    expect(url).toBeNull();
  });
});
