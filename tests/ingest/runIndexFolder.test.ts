import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, utimesSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { join } from "node:path";
import { runIndexFolder } from "../../src/commands/index.ts";
import { ensureFresh } from "../../src/ingest/ingester.ts";
import { setConfig } from "../../src/archive/open.ts";
import { makeEnv, queryOne, stubEmbed, type TestEnv } from "../helpers.ts";

const RecordingRowSchema = z.object({
  folder_name: z.string(),
  datetime: z.string(),
  result: z.string().nullable(),
});

let env: TestEnv;

beforeEach(() => {
  env = makeEnv();
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

function defaultBulkOpts() {
  return {
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  };
}

function defaultFolderOpts(folderName: string) {
  return {
    folderName,
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  };
}

describe("runIndexFolder", () => {
  test("first call inserts the targeted row even on an empty archive", async () => {
    const r = await runIndexFolder(defaultFolderOpts("1779000000"));
    expect(r.existed).toBe(false);
    const db = new Database(env.archive, { readonly: true });
    try {
      const row = queryOne(
        db,
        RecordingRowSchema,
        "SELECT folder_name, datetime, result FROM recording WHERE folder_name = ?",
        "1779000000",
      );
      expect(row.folder_name).toBe("1779000000");
    } finally {
      db.close();
    }
  });

  test("call against a non-existent folder throws", async () => {
    await expect(runIndexFolder(defaultFolderOpts("does-not-exist"))).rejects.toThrow(
      /no row for folderName/,
    );
  });

  test("re-running on an already-ingested folder updates in place (existed=true)", async () => {
    await runIndexFolder(defaultFolderOpts("1779000000"));
    const r2 = await runIndexFolder(defaultFolderOpts("1779000000"));
    expect(r2.existed).toBe(true);
  });

  test(
    "PATCHED-ROW REGRESSION: a folder whose SW datetime is patched into the past " +
      "is recovered by runIndexFolder where the bulk path would miss it",
    async () => {
      // Step 1: bulk-ingest everything so `last_indexed_datetime` is
      // set to the newest source datetime.
      await ensureFresh(defaultBulkOpts());

      // Step 2: simulate a SW post-patch state — write a past-datetime
      // value directly into the source DB row, mimicking what the
      // patcher would do. This must be < last_indexed_datetime so the
      // bulk path's WHERE clause excludes it.
      const PATCHED_DATETIME = "2020-01-01T00:00:00";
      {
        const sdb = new Database(env.sourceDb);
        sdb
          .prepare("UPDATE recording SET datetime = ? WHERE folderName = ?")
          .run(PATCHED_DATETIME, "1779000000");
        // Also patch the meta.json so readMetaContext is consistent.
        const metaPath = join(env.sourceDir, "recordings", "1779000000", "meta.json");
        const meta = JSON.parse(await Bun.file(metaPath).text());
        meta.datetime = PATCHED_DATETIME;
        await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
        sdb.close();
        // Bump source DB mtime so the bulk path takes the slow path on
        // a second run.
        const now = new Date();
        utimesSync(env.sourceDb, now, now);
      }

      // Step 3: bulk path would miss the patched row because the
      // datetime is < last_indexed_datetime.
      const bulk = await ensureFresh(defaultBulkOpts());
      expect(bulk.fastPath).toBe(false);
      const archive = new Database(env.archive, { readonly: true });
      try {
        const after = queryOne(
          archive,
          RecordingRowSchema,
          "SELECT folder_name, datetime, result FROM recording WHERE folder_name = ?",
          "1779000000",
        );
        // Bulk path never re-ingested → archive's datetime is the
        // original.
        expect(after.datetime).not.toBe(PATCHED_DATETIME);
      } finally {
        archive.close();
      }

      // Step 4: targeted ingest. After this, the archive's datetime
      // reflects the patched value.
      await runIndexFolder(defaultFolderOpts("1779000000"));
      const archive2 = new Database(env.archive, { readonly: true });
      try {
        const after = queryOne(
          archive2,
          RecordingRowSchema,
          "SELECT folder_name, datetime, result FROM recording WHERE folder_name = ?",
          "1779000000",
        );
        expect(after.datetime).toBe(PATCHED_DATETIME);
      } finally {
        archive2.close();
      }
    },
  );

  test("does NOT touch last_indexed_datetime", async () => {
    // Set a sentinel value and check runIndexFolder leaves it alone.
    await ensureFresh(defaultBulkOpts());
    const sentinel = "9999-12-31T23:59:59";
    // Use the source DB to write; opening the archive directly here
    // bypasses migrations + ext loading. ensureFresh has already
    // initialised the archive so we use bun:sqlite directly.
    const w = new Database(env.archive);
    try {
      setConfig(w, "last_indexed_datetime", sentinel);
    } finally {
      w.close();
    }
    await runIndexFolder(defaultFolderOpts("1779000200"));
    const ro = new Database(env.archive, { readonly: true });
    try {
      const got = queryOne(
        ro,
        z.object({ value: z.string() }),
        "SELECT value FROM config WHERE key = 'last_indexed_datetime'",
      );
      expect(got.value).toBe(sentinel);
    } finally {
      ro.close();
    }
  });
});
