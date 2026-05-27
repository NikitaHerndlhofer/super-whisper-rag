import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatch, type WatchOptions } from "../../src/watch/watcher.ts";

let workDir: string;
let sourceDir: string;
let sourceDb: string;
let archive: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-watch-"));
  sourceDir = join(workDir, "recordings");
  const dbDir = join(workDir, "db");
  sourceDb = join(dbDir, "superwhisper.sqlite");
  archive = join(workDir, "archive", "swrag.sqlite");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  // Placeholder file at sourceDb so the parent-dir watch has
  // something realistic to track. Empty content is fine — the watcher
  // only listens for fs change events, not DB content.
  writeFileSync(sourceDb, "");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function baseOpts(over: Partial<WatchOptions> = {}): WatchOptions {
  return {
    archive,
    sourceDir,
    sourceDb,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    skipEmbeddings: true,
    debounceMs: 50,
    ...over,
  };
}

/**
 * Spin up runWatch with an injected ingest function and abort
 * controller, drive a few fs events through, then abort cleanly.
 * Returns the number of ingest calls observed.
 */
async function runScenario(
  inject: (signal: AbortController) => void | Promise<void>,
  over: Partial<WatchOptions> = {},
): Promise<number> {
  const ac = new AbortController();
  let calls = 0;
  const cycleCompleted: Array<() => void> = [];
  const ingest = async (_opts: WatchOptions) => {
    calls++;
  };

  const opts = baseOpts({
    abortSignal: ac.signal,
    runIngest: ingest,
    onIngestComplete: () => {
      const w = cycleCompleted.shift();
      w?.();
    },
    ...over,
  });

  const waitForCycle = () =>
    new Promise<void>((res) => {
      cycleCompleted.push(res);
    });

  // Wait for the initial startup cycle to complete (the watcher
  // always kicks one ingest at startup).
  const startupDone = waitForCycle();
  const runPromise = runWatch(opts);
  await startupDone;

  await inject(ac);

  ac.abort();
  await runPromise;
  return calls;
}

describe("runWatch", () => {
  test("startup ingest fires exactly once before any events", async () => {
    const calls = await runScenario(async () => {});
    expect(calls).toBe(1);
  });

  test("debounces a burst of fs events into FAR fewer ingests than events", async () => {
    // The exact post-burst ingest count is timing-sensitive across
    // macOS / Linux fs.watch implementations — what we care about
    // architecturally is "5 events do NOT cause 5 separate ingests".
    // Anything <= 2 (startup + at most 1 coalesced burst) proves the
    // debouncer is doing its job.
    let calls = 0;
    const ac = new AbortController();
    const cycles: Array<() => void> = [];
    const ingest = async () => {
      calls++;
    };
    const opts = baseOpts({
      abortSignal: ac.signal,
      runIngest: ingest,
      debounceMs: 100,
      onIngestComplete: () => cycles.shift()?.(),
    });
    const waitForCycle = () =>
      new Promise<void>((res) => {
        cycles.push(res);
      });

    const startupDone = waitForCycle();
    const runPromise = runWatch(opts);
    await startupDone;
    expect(calls).toBe(1);

    // Burst of writes; then await EXACTLY one more cycle.
    const coalescedDone = waitForCycle();
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(sourceDir, `r${i}.txt`), "x");
    }
    await coalescedDone;
    // Give the debouncer a quiet window to confirm no extra cycle is
    // queued behind us — 3x the debounce is more than enough.
    await new Promise((r) => setTimeout(r, 350));
    ac.abort();
    await runPromise;

    expect(calls).toBeLessThanOrEqual(3); // 1 startup + ≤2 coalesced
    expect(calls).toBeGreaterThanOrEqual(2); // at least one coalesced
  });

  test("fs events on the source DB parent dir also trigger an ingest", async () => {
    // We trigger via creating a NEW file in the parent dir rather
    // than modifying the existing sourceDb. macOS FSEvents (which
    // backs fs.watch with recursive:false) reliably fires for
    // create/delete/rename but batches plain content modifications
    // at the kernel level — modifications may not surface within a
    // test's 5s budget on GitHub's macos-latest runners. The
    // watcher's `""`/`<basename>-*` filter accepts SQLite's WAL/SHM
    // family, so creating `${sourceDb}-wal` here mirrors what a
    // real SQLite WAL-mode commit produces.
    let calls = 0;
    const ac = new AbortController();
    const cycles: Array<() => void> = [];
    const opts = baseOpts({
      abortSignal: ac.signal,
      runIngest: async () => {
        calls++;
      },
      onIngestComplete: () => cycles.shift()?.(),
    });
    const waitForCycle = () =>
      new Promise<void>((res) => {
        cycles.push(res);
      });
    const startupDone = waitForCycle();
    const runPromise = runWatch(opts);
    await startupDone;

    const second = waitForCycle();
    writeFileSync(`${sourceDb}-wal`, "wal contents");
    await second;
    ac.abort();
    await runPromise;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("SIGTERM-equivalent (abortSignal) tears down cleanly without hanging", async () => {
    // The scenario itself proves clean teardown — if the watcher
    // didn't honour the abort, runPromise would never resolve and the
    // test would time out.
    const calls = await runScenario(async () => {});
    expect(calls).toBe(1);
  });

  test("ingest failures don't crash the daemon; later events still trigger ingest", async () => {
    let calls = 0;
    const ac = new AbortController();
    const cycles: Array<() => void> = [];
    const ingest = async () => {
      calls++;
      if (calls === 1) throw new Error("simulated ollama outage");
    };
    const opts = baseOpts({
      abortSignal: ac.signal,
      runIngest: ingest,
      onIngestComplete: () => cycles.shift()?.(),
    });

    const waitForCycle = () =>
      new Promise<void>((res) => {
        cycles.push(res);
      });

    const startupDone = waitForCycle();
    const runPromise = runWatch(opts);
    await startupDone;
    // First (startup) ingest threw. Now trigger a follow-up.
    const second = waitForCycle();
    writeFileSync(join(sourceDir, "later.txt"), "y");
    await second;
    ac.abort();
    await runPromise;
    expect(calls).toBe(2);
  });

  test("missing sourceDir errors clearly on startup", async () => {
    const missing = join(workDir, "does-not-exist");
    await expect(
      runWatch(
        baseOpts({
          sourceDir: missing,
          // abortSignal omitted — the throw happens before signal wiring.
        }),
      ),
    ).rejects.toThrow(/source dir does not exist/);
  });

  test("missing sourceDb parent dir errors clearly on startup", async () => {
    await expect(
      runWatch(
        baseOpts({
          sourceDb: "/totally/made/up/path/sw.sqlite",
        }),
      ),
    ).rejects.toThrow(/source DB parent dir does not exist/);
  });
});
