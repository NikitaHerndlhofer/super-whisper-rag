/**
 * Tests for the data-updater runner in `src/archive/update.ts` and the
 * shape invariants of the `UPDATERS` array in `src/archive/updaters.ts`.
 *
 * These mirror the patterns in `tests/migrations.test.ts` (array
 * invariants, fresh-vs-stale archive behavior) and pull the same
 * fixture/stubEmbed harness as `tests/ingest.test.ts` and
 * `tests/chunking.test.ts` for the `ensureFresh`-driven scenarios.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { z } from "zod";
import { runUpdaters } from "../src/archive/update.ts";
import { LATEST_DATA_VERSION, UPDATERS, type Updater } from "../src/archive/updaters.ts";
import { ensureFresh, type IngestOptions } from "../src/ingest/ingester.ts";
import { ensureExtensionCapableSqlite } from "../src/archive/open.ts";
import { vecDylibPath } from "../src/archive/vec-loader.ts";
import { makeEnv, queryOne, stubEmbed, type TestEnv } from "./helpers.ts";

ensureExtensionCapableSqlite();

const DataVersionRowSchema = z.object({ value: z.string() });
const CountRowSchema = z.object({ n: z.number() });

let env: TestEnv;

beforeEach(() => {
  env = makeEnv();
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

function defaultOpts(): IngestOptions {
  return {
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  };
}

function openArchiveRw(): Database {
  const db = new Database(env.archive);
  db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
  return db;
}

function readDataVersionRaw(db: Database): string | null {
  const raw: unknown = db.prepare("SELECT value FROM config WHERE key = 'data_version'").get();
  if (raw == null) return null;
  return DataVersionRowSchema.parse(raw).value;
}

describe("UPDATERS array", () => {
  test("versions are strictly increasing integers", () => {
    for (let i = 1; i < UPDATERS.length; i++) {
      const prev = UPDATERS[i - 1];
      const cur = UPDATERS[i];
      if (!prev || !cur) throw new Error("missing updater entry");
      expect(cur.version).toBeGreaterThan(prev.version);
      expect(Number.isInteger(cur.version)).toBe(true);
    }
  });

  test("LATEST_DATA_VERSION matches the last entry", () => {
    const last = UPDATERS[UPDATERS.length - 1];
    expect(last?.version).toBe(LATEST_DATA_VERSION);
  });

  test("every updater has a non-empty name and a callable fn", () => {
    for (const u of UPDATERS) {
      expect(u.name.length).toBeGreaterThan(0);
      expect(typeof u.fn).toBe("function");
    }
  });
});

describe("ensureFresh on a fresh archive seeds data_version to LATEST", () => {
  test("first run does not apply any updaters; data_version starts at LATEST_DATA_VERSION", async () => {
    await ensureFresh(defaultOpts());

    const db = openArchiveRw();
    try {
      // The `initialiseConfig` seed runs only for truly fresh archives
      // (recording table empty at open time), so data_version is
      // pre-seeded to LATEST_DATA_VERSION before runUpdaters ever sees
      // a 0. A subsequent direct runUpdaters call should therefore
      // find nothing to apply, proving the first ensureFresh did not
      // run any updaters either.
      expect(readDataVersionRaw(db)).toBe(String(LATEST_DATA_VERSION));
      const outcome = await runUpdaters(db, defaultOpts());
      expect(outcome.applied).toEqual([]);
      expect(outcome.fromVersion).toBe(LATEST_DATA_VERSION);
    } finally {
      db.close();
    }
  });

  test("re-running ensureFresh keeps data_version at LATEST_DATA_VERSION", async () => {
    await ensureFresh(defaultOpts());
    await ensureFresh(defaultOpts());

    const db = openArchiveRw();
    try {
      expect(readDataVersionRaw(db)).toBe(String(LATEST_DATA_VERSION));
    } finally {
      db.close();
    }
  });
});

describe("ensureFresh on a pre-updater archive applies pending updaters", () => {
  test("missing data_version → updaters run, data_version bumped, idempotent on re-run", async () => {
    // Seed a fresh archive at LATEST_DATA_VERSION (via the
    // INITIAL_CONFIG seed), then strip the row to simulate an archive
    // created by a pre-updater-system binary.
    await ensureFresh(defaultOpts());
    {
      const db = openArchiveRw();
      try {
        db.exec("DELETE FROM config WHERE key = 'data_version'");
      } finally {
        db.close();
      }
    }
    expect(await readDataVersionViaShortLivedConnection()).toBeNull();

    await ensureFresh(defaultOpts());

    expect(await readDataVersionViaShortLivedConnection()).toBe(String(LATEST_DATA_VERSION));

    // Subsequent run: stored data_version >= every UPDATERS entry, so
    // no updater runs. We can verify by capturing the outcome of a
    // direct `runUpdaters` call against the live archive.
    const db = openArchiveRw();
    try {
      const outcome = await runUpdaters(db, defaultOpts());
      expect(outcome.applied).toEqual([]);
      expect(outcome.fromVersion).toBe(LATEST_DATA_VERSION);
      expect(outcome.toVersion).toBe(LATEST_DATA_VERSION);
    } finally {
      db.close();
    }
  });

  async function readDataVersionViaShortLivedConnection(): Promise<string | null> {
    const db = new Database(env.archive);
    try {
      return readDataVersionRaw(db);
    } finally {
      db.close();
    }
  }
});

describe("runUpdaters failure semantics", () => {
  test("a throwing updater aborts the run, leaves data_version untouched, retries on next call", async () => {
    // First, seed the archive (so the recording schema exists and
    // ensureFresh has stabilised).
    await ensureFresh(defaultOpts());

    // Simulate a pre-updater archive AND inject a stub updater that
    // fails on its first call.
    const db = openArchiveRw();
    try {
      db.exec("DELETE FROM config WHERE key = 'data_version'");
    } finally {
      db.close();
    }

    let calls = 0;
    let shouldThrow = true;
    const flaky: Updater = {
      version: 999,
      name: "flaky_test_updater",
      fn: async () => {
        calls++;
        if (shouldThrow) throw new Error("flaky updater boom");
      },
    };

    const live1 = openArchiveRw();
    try {
      await expect(runUpdaters(live1, defaultOpts(), [flaky])).rejects.toThrow(/flaky/);
      // data_version should be untouched (no row at all, because we
      // deleted it above and the runner doesn't bump on failure).
      expect(readDataVersionRaw(live1)).toBeNull();
      expect(calls).toBe(1);
    } finally {
      live1.close();
    }

    // Flip the stub to succeed; rerun → updater is retried and bumps
    // data_version.
    shouldThrow = false;
    const live2 = openArchiveRw();
    try {
      const outcome = await runUpdaters(live2, defaultOpts(), [flaky]);
      expect(outcome.applied).toEqual([999]);
      expect(readDataVersionRaw(live2)).toBe("999");
      expect(calls).toBe(2);
    } finally {
      live2.close();
    }
  });

  test("filtered by version: stored data_version above the updater's version is a no-op", async () => {
    await ensureFresh(defaultOpts());
    // ensureFresh leaves data_version = LATEST_DATA_VERSION (>= 4).
    const stub: Updater = {
      version: 1,
      name: "stale_test_updater",
      fn: async () => {
        throw new Error("should not run");
      },
    };
    const db = openArchiveRw();
    try {
      const outcome = await runUpdaters(db, defaultOpts(), [stub]);
      expect(outcome.applied).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("recording_chunk presence (smoke for updater 4's defensive assertion)", () => {
  test("after migration runs, recording_chunk table exists", async () => {
    await ensureFresh(defaultOpts());
    const db = openArchiveRw();
    try {
      const row = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='recording_chunk'",
      );
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
