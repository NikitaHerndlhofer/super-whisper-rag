/**
 * Integration tests for `spawnEventsHelper`.
 *
 * Two layers of coverage:
 *
 *  1. Real-helper integration — runs the actual vendored Swift binary,
 *     captures the snapshot event, asserts the schema. Skipped when the
 *     binary isn't present (CI without the swift toolchain).
 *  2. Fake-helper line framing — points `SWRAG_HELPER_PATH` at a tiny
 *     shell script that emits a canned NDJSON sequence, asserts emission
 *     order, EOF termination, and that `stop()` is idempotent. These run
 *     anywhere bash is available, which on darwin is "always".
 *
 * Real-binary tests don't try to provoke hot-plug or mic_changed events
 * because we can't fake CoreAudio notifications without modifying the
 * Swift source. The snapshot path is the load-bearing one — every
 * subsequent event uses the same JSON framing + schema.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLineSchema,
  type EventLine,
  spawnEventsHelper,
} from "../../src/mac/helper.ts";

const REAL_HELPER = join(import.meta.dir, "..", "..", "vendor", "swrag-helper-darwin-universal");
const REAL_HELPER_PRESENT = existsSync(REAL_HELPER);

/* -------------------------------------------------------------------------- */
/* Real helper (skipped when binary is absent)                                */
/* -------------------------------------------------------------------------- */

describe.skipIf(!REAL_HELPER_PRESENT)("spawnEventsHelper (real binary)", () => {
  test("emits a schema-valid snapshot within 2 s of launch", async () => {
    const handle = spawnEventsHelper({ helperPath: REAL_HELPER });
    try {
      const ev = await firstEvent(handle.events, 2_000);
      expect(ev).not.toBeNull();
      const parsed = EventLineSchema.safeParse(ev);
      expect(parsed.success).toBe(true);
      // First event is the bootstrap snapshot, by contract.
      expect(ev?.event).toBe("snapshot");
    } finally {
      await handle.stop();
    }
  });

  test("stop() terminates the subprocess and resolves cleanly even when called twice", async () => {
    const handle = spawnEventsHelper({ helperPath: REAL_HELPER });
    // Wait until we see at least the snapshot before stopping — that
    // proves the subprocess is alive and we're stopping a real running
    // helper, not just a process that hadn't started yet.
    await firstEvent(handle.events, 2_000);
    const t0 = performance.now();
    await handle.stop();
    await handle.stop();
    const elapsed = performance.now() - t0;
    // Swift helper takes SIGTERM and shuts down cleanly; allow generous
    // slack to account for slow CI.
    expect(elapsed).toBeLessThan(3_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Fake helper — exercises the line-framing iterator end-to-end               */
/* -------------------------------------------------------------------------- */

describe("spawnEventsHelper (fake helper for line-framing)", () => {
  test("parses a canned NDJSON sequence in emission order, then ends on EOF", async () => {
    const events = [
      JSON.stringify({
        event: "snapshot",
        frontmost: { bundleId: "com.apple.Notes", name: "Notes", pid: 100 },
        mic: { in_use: false, owners: [] },
        running_call_apps: { strict: [], soft: [] },
      }),
      JSON.stringify({
        event: "frontmost_changed",
        bundle_id: "us.zoom.xos",
        name: "zoom.us",
        pid: 200,
      }),
      JSON.stringify({ event: "mic_changed", in_use: true, owners: [] }),
      JSON.stringify({
        event: "app_terminated",
        bundle_id: "us.zoom.xos",
        name: "zoom.us",
        pid: 200,
      }),
    ];
    const fake = writeFakeHelper(`${events.join("\n")}\n`);
    const handle = spawnEventsHelper({ helperPath: fake });
    try {
      const collected: EventLine[] = [];
      for await (const ev of handle.events) {
        collected.push(ev);
      }
      expect(collected.map((e) => e.event)).toEqual([
        "snapshot",
        "frontmost_changed",
        "mic_changed",
        "app_terminated",
      ]);
    } finally {
      await handle.stop();
    }
  });

  test("invalid lines throw by default (no silent data loss)", async () => {
    const corpus =
      JSON.stringify({
        event: "snapshot",
        frontmost: { bundleId: null, name: null, pid: null },
        mic: { in_use: false, owners: [] },
        running_call_apps: { strict: [], soft: [] },
      }) +
      "\n" +
      "this is not json\n";
    const fake = writeFakeHelper(corpus);
    const handle = spawnEventsHelper({ helperPath: fake });
    try {
      await expect(
        (async () => {
          for await (const _ev of handle.events) {
            // consume
          }
        })(),
      ).rejects.toThrow(/invalid line/);
    } finally {
      await handle.stop();
    }
  });

  test("ignoreInvalidLines drops malformed lines silently and continues", async () => {
    const corpus =
      JSON.stringify({
        event: "snapshot",
        frontmost: { bundleId: null, name: null, pid: null },
        mic: { in_use: false, owners: [] },
        running_call_apps: { strict: [], soft: [] },
      }) +
      "\n" +
      "garbage line\n" +
      JSON.stringify({ event: "mic_changed", in_use: true, owners: [] }) +
      "\n";
    const fake = writeFakeHelper(corpus);
    const handle = spawnEventsHelper({ helperPath: fake, ignoreInvalidLines: true });
    try {
      const collected: EventLine[] = [];
      for await (const ev of handle.events) {
        collected.push(ev);
      }
      expect(collected.map((e) => e.event)).toEqual(["snapshot", "mic_changed"]);
    } finally {
      await handle.stop();
    }
  });

  test("stderr is drained and surfaced via stderrTail() (no silent loss, no back-pressure)", async () => {
    // Fake helper writes 64 KB of stderr first (large enough to fill the
    // OS pipe buffer if nobody read it — proves we ARE reading), then
    // emits one snapshot event on stdout. Without an active stderr
    // drain the helper would stall on the very first stderr write
    // and the snapshot would never arrive.
    const big = "noisy diagnostic line\n".repeat(3_000);
    const stdoutBody = `${JSON.stringify({
      event: "snapshot",
      frontmost: { bundleId: null, name: null, pid: null },
      mic: { in_use: false, owners: [] },
      running_call_apps: { strict: [], soft: [] },
    })}\n`;
    const fake = writeFakeHelperWithStderr(stdoutBody, big);
    const handle = spawnEventsHelper({ helperPath: fake });
    try {
      const collected: EventLine[] = [];
      for await (const ev of handle.events) {
        collected.push(ev);
      }
      expect(collected.map((e) => e.event)).toEqual(["snapshot"]);
    } finally {
      await handle.stop();
    }
    // stop() awaits the stderr drain — by here we should have the tail.
    const tail = handle.stderrTail();
    expect(tail.length).toBeGreaterThan(0);
    expect(tail).toContain("noisy diagnostic line");
    // Sanity: the tail is bounded (we keep the last ~8 KB, not the
    // whole 64 KB).
    expect(tail.length).toBeLessThan(64 * 1024);
  });

  test("stderrTail() captures helper output even when stdout is empty (crash diagnosis path)", async () => {
    // Helper writes only to stderr and exits 1 — the iterator yields
    // nothing. This is the scenario the CLI's `meeting status` error
    // path uses to attach a Swift-side stack trace to its error.
    const fake = writeFakeHelperWithStderr("", "fatal: simulated crash on startup\n");
    const handle = spawnEventsHelper({ helperPath: fake });
    try {
      const collected: EventLine[] = [];
      for await (const ev of handle.events) {
        collected.push(ev);
      }
      expect(collected).toHaveLength(0);
    } finally {
      await handle.stop();
    }
    expect(handle.stderrTail()).toContain("simulated crash");
  });
});

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pull the first event off the async iterator with a hard timeout.
 * Returns null on timeout rather than throwing — the caller asserts.
 */
async function firstEvent(
  events: AsyncIterable<EventLine>,
  timeoutMs: number,
): Promise<EventLine | null> {
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

/**
 * Materialise a tiny bash script that prints `body` to stdout and exits
 * 0. Used in place of the real Swift helper for line-framing tests.
 */
function writeFakeHelper(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swrag-fake-helper-"));
  const path = join(dir, "fake-helper.sh");
  // Use printf with %s so embedded backslashes / dollar signs in the
  // NDJSON corpus don't get re-interpreted by the shell.
  const escaped = body.replace(/'/g, "'\\''");
  const script = `#!/bin/bash\nprintf '%s' '${escaped}'\n`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Two-channel variant: writes `stderrBody` to fd 2 BEFORE `stdoutBody` to
 * fd 1. The order matters for the back-pressure test — if the spawner
 * isn't draining stderr, the stderr write will block before stdout ever
 * sees a byte.
 */
function writeFakeHelperWithStderr(stdoutBody: string, stderrBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swrag-fake-helper-"));
  const path = join(dir, "fake-helper-stderr.sh");
  const escStdout = stdoutBody.replace(/'/g, "'\\''");
  const escStderr = stderrBody.replace(/'/g, "'\\''");
  const script = `#!/bin/bash\nprintf '%s' '${escStderr}' 1>&2\nprintf '%s' '${escStdout}'\n`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}
