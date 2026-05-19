import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, utimesSync } from "node:fs";
import { z } from "zod";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { makeEnv, queryOne, stubEmbed, type TestEnv } from "./helpers.ts";

const CountRowSchema = z.object({ n: z.number() });
const DeletedAtRowSchema = z.object({
  source_deleted_at: z.string().nullable(),
});

let env: TestEnv;

beforeEach(() => {
  env = makeEnv();
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

function defaultOpts() {
  return {
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  };
}

describe("ensureFresh", () => {
  test("first run ingests every source row", async () => {
    const r = await ensureFresh(defaultOpts());
    expect(r.fastPath).toBe(false);
    expect(r.newRows).toBeGreaterThanOrEqual(5);

    const db = new Database(env.archive, { readonly: true });
    try {
      const total = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording",
      );
      // 5 rows in source DB + 1 source row with no meta is still ingested.
      expect(total.n).toBe(6);
    } finally {
      db.close();
    }
  });

  test("second run hits the mtime fast path", async () => {
    await ensureFresh(defaultOpts());
    const r = await ensureFresh(defaultOpts());
    expect(r.fastPath).toBe(true);
    expect(r.embedded).toBe(0);
    expect(r.newRows).toBe(0);
  });

  test("source row removed -> source_deleted_at is set", async () => {
    await ensureFresh(defaultOpts());

    const sdb = new Database(env.sourceDb);
    sdb.exec("DELETE FROM recording WHERE folderName = '1779000400'");
    sdb.close();
    const now = new Date();
    utimesSync(env.sourceDb, now, now);

    rmSync(`${env.sourceDir}/recordings/1779000400`, {
      recursive: true,
      force: true,
    });

    const r = await ensureFresh(defaultOpts());
    expect(r.fastPath).toBe(false);
    expect(r.sourceDeletions).toBe(1);

    const db = new Database(env.archive, { readonly: true });
    try {
      const row = queryOne(
        db,
        DeletedAtRowSchema,
        "SELECT source_deleted_at FROM recording WHERE folder_name = ?",
        "1779000400",
      );
      expect(row.source_deleted_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("model switch wipes vec table and re-embeds", async () => {
    await ensureFresh({ ...defaultOpts(), embedModel: "model-A" });
    const now = new Date();
    utimesSync(env.sourceDb, now, now);

    const r = await ensureFresh({ ...defaultOpts(), embedModel: "model-B" });
    expect(r.modelSwitched).toBe(true);
    expect(r.embedded).toBeGreaterThanOrEqual(5);
  });

  test("--full forces a re-embed even without model change", async () => {
    await ensureFresh({ ...defaultOpts(), embedModel: "model-A" });
    const r = await ensureFresh({
      ...defaultOpts(),
      embedModel: "model-A",
      full: true,
    });
    expect(r.fastPath).toBe(false);
    expect(r.embedded).toBeGreaterThanOrEqual(5);
  });

  test("skipEmbeddings keeps text but does not call embed", async () => {
    let calls = 0;
    const fn = async (texts: string[]) => {
      calls++;
      return stubEmbed(texts);
    };
    await ensureFresh({ ...defaultOpts(), embedFn: fn, skipEmbeddings: true });
    expect(calls).toBe(0);
    const db = new Database(env.archive, { readonly: true });
    try {
      const n = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording",
      );
      expect(n.n).toBeGreaterThanOrEqual(5);
    } finally {
      db.close();
    }
  });
});
