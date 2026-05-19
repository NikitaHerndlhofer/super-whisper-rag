import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ensureExtensionCapableSqlite } from "../src/archive/open.ts";
import { vecDylibPath } from "../src/archive/vec-loader.ts";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { makeEnv, queryAll, stubEmbed, type TestEnv } from "./helpers.ts";

let env: TestEnv;

const SupersedenceRowSchema = z.object({
  folder_name: z.string(),
  superseded_by: z.string().nullable(),
  audio_hash: z.string().nullable(),
});

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

describe("Super Whisper reprocessing → supersedence", () => {
  test("rows with identical audio collapse to one canonical (latest datetime wins)", async () => {
    // Force two fixtures to share the same audio payload, simulating a
    // Super Whisper reprocess of the same recording into a different mode.
    const sharedPayload = Buffer.from("reprocess-target-audio");
    writeFileSync(`${env.sourceDir}/recordings/1779000000/output.wav`, sharedPayload);
    writeFileSync(`${env.sourceDir}/recordings/1779000200/output.wav`, sharedPayload);

    const r = await ensureFresh(defaultOpts());
    expect(r.fastPath).toBe(false);

    const db = new Database(env.archive, { readonly: true });
    try {
      const rows = queryAll(
        db,
        SupersedenceRowSchema,
        `SELECT folder_name, superseded_by, audio_hash
         FROM recording
         WHERE folder_name IN ('1779000000', '1779000200')
         ORDER BY datetime DESC`,
      );
      // Latest datetime (1779000000 → 2026-05-18) is canonical.
      // Older one (1779000200 → 2026-05-16) is superseded.
      expect(rows).toHaveLength(2);
      expect(rows[0]?.folder_name).toBe("1779000000");
      expect(rows[0]?.superseded_by).toBeNull();
      expect(rows[1]?.folder_name).toBe("1779000200");
      expect(rows[1]?.superseded_by).toBe("1779000000");
      // Both share the same audio_hash.
      expect(rows[0]?.audio_hash).toBe(rows[1]?.audio_hash);
    } finally {
      db.close();
    }
  });

  test("superseded rows are not embedded", async () => {
    const sharedPayload = Buffer.from("shared-audio");
    writeFileSync(`${env.sourceDir}/recordings/1779000000/output.wav`, sharedPayload);
    writeFileSync(`${env.sourceDir}/recordings/1779000200/output.wav`, sharedPayload);

    let embedCount = 0;
    await ensureFresh({
      ...defaultOpts(),
      embedFn: async (texts) => {
        embedCount += texts.length;
        return stubEmbed(texts);
      },
    });
    // 6 fixture rows total; 2 of them collapse to 1 canonical → 5 embeds.
    // (One fixture has no audio, so it's not in any supersedence group.)
    expect(embedCount).toBeLessThan(6);
  });

  test("superseded rows have no entry in recording_vec", async () => {
    const sharedPayload = Buffer.from("shared-audio-2");
    writeFileSync(`${env.sourceDir}/recordings/1779000000/output.wav`, sharedPayload);
    writeFileSync(`${env.sourceDir}/recordings/1779000200/output.wav`, sharedPayload);

    await ensureFresh(defaultOpts());

    ensureExtensionCapableSqlite();
    const db = new Database(env.archive, { readonly: true });
    db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
    try {
      const vecRowsSchema = z.object({ n: z.number() });
      // Superseded row (1779000200) should be absent from recording_vec
      // entirely — otherwise the join `recording_vec → recording WHERE
      // superseded_by IS NULL` silently hides it, but the vector slot
      // wastes space and risks confusing readers who assume vec rows
      // are canonical.
      const supersededVec = queryAll(
        db,
        vecRowsSchema,
        "SELECT COUNT(*) AS n FROM recording_vec WHERE folder_name = '1779000200'",
      );
      expect(supersededVec[0]?.n).toBe(0);
      const canonicalVec = queryAll(
        db,
        vecRowsSchema,
        "SELECT COUNT(*) AS n FROM recording_vec WHERE folder_name = '1779000000'",
      );
      expect(canonicalVec[0]?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("clearing the duplicate restores the other row to canonical", async () => {
    const sharedPayload = Buffer.from("once-shared");
    const distinctPayload = Buffer.from("now-distinct");
    writeFileSync(`${env.sourceDir}/recordings/1779000000/output.wav`, sharedPayload);
    writeFileSync(`${env.sourceDir}/recordings/1779000200/output.wav`, sharedPayload);
    await ensureFresh(defaultOpts());

    // Now make the older row's audio distinct, force re-hash, re-run.
    writeFileSync(`${env.sourceDir}/recordings/1779000200/output.wav`, distinctPayload);
    const db = new Database(env.archive);
    db.exec("UPDATE recording SET audio_hash = NULL WHERE folder_name = '1779000200'");
    db.close();
    const now = new Date();
    utimesSync(env.sourceDb, now, now);

    await ensureFresh(defaultOpts());
    const db2 = new Database(env.archive, { readonly: true });
    try {
      const rows = queryAll(
        db2,
        SupersedenceRowSchema,
        `SELECT folder_name, superseded_by, audio_hash
         FROM recording
         WHERE folder_name IN ('1779000000', '1779000200')`,
      );
      for (const row of rows) {
        expect(row.superseded_by).toBeNull();
      }
    } finally {
      db2.close();
    }
  });

  test("restored canonical row gets its vec entry re-created", async () => {
    // Regression test: a row that was superseded (vec deleted) and later
    // promoted back to canonical must end up with a vec entry. Previously
    // the embed pass keyed only on embed_text_hash/model, which still
    // matched the prior canonical embedding, so the row was skipped and
    // left without a vec entry.
    const sharedPayload = Buffer.from("regression-shared");
    const distinctPayload = Buffer.from("regression-distinct");
    writeFileSync(`${env.sourceDir}/recordings/1779000000/output.wav`, sharedPayload);
    writeFileSync(`${env.sourceDir}/recordings/1779000200/output.wav`, sharedPayload);
    await ensureFresh(defaultOpts());

    // Sanity: 1779000200 is currently superseded → its vec entry was dropped.
    ensureExtensionCapableSqlite();
    {
      const db = new Database(env.archive, { readonly: true });
      db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
      try {
        const supersededVec = queryAll(
          db,
          z.object({ n: z.number() }),
          "SELECT COUNT(*) AS n FROM recording_vec WHERE folder_name = '1779000200'",
        );
        expect(supersededVec[0]?.n).toBe(0);
      } finally {
        db.close();
      }
    }

    // Diverge the older row's audio so it's no longer a duplicate.
    writeFileSync(`${env.sourceDir}/recordings/1779000200/output.wav`, distinctPayload);
    const db = new Database(env.archive);
    db.exec("UPDATE recording SET audio_hash = NULL WHERE folder_name = '1779000200'");
    db.close();
    const now = new Date();
    utimesSync(env.sourceDb, now, now);

    await ensureFresh(defaultOpts());

    const db2 = new Database(env.archive, { readonly: true });
    db2.loadExtension(vecDylibPath(), "sqlite3_vec_init");
    try {
      const restoredVec = queryAll(
        db2,
        z.object({ n: z.number() }),
        "SELECT COUNT(*) AS n FROM recording_vec WHERE folder_name = '1779000200'",
      );
      expect(restoredVec[0]?.n).toBe(1);
    } finally {
      db2.close();
    }
  });
});
