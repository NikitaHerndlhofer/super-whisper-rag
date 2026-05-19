import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { z } from "zod";
import { runSql } from "../src/commands/sql.ts";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { makeEnv, stubEmbed, type TestEnv } from "./helpers.ts";

let env: TestEnv;

beforeEach(async () => {
  env = makeEnv();
  await ensureFresh({
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  });
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

/**
 * End-to-end tests of the agent-facing surface. We stub the query embedding by
 * shadowing `embedSync` via the env's host (we set it to an unreachable port
 * and our test calls instead a direct prepared statement using vec functions).
 *
 * For semantic recipes (cookbook 4–6), runSql() calls embedSync which hits
 * curl — to keep tests offline we'd need a real fake Ollama. Instead, here we
 * exercise the same SQL surface using bound vectors directly. The full
 * embed(:q) substitution path is unit-tested in safety.test.ts.
 */
const VecRowSchema = z.object({
  folder_name: z.string(),
  embedding: z.instanceof(Uint8Array),
});

const RankedRowSchema = z.object({
  folder_name: z.string(),
  d: z.number(),
});

describe("semantic search SQL surface (cookbook 4)", () => {
  test("vec_distance_cosine ranks rows", async () => {
    const { Database } = await import("bun:sqlite");
    const { vecDylibPath } = await import("../src/archive/vec-loader.ts");
    const db = new Database(env.archive, { readonly: true });
    db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
    const rawRow: unknown = db
      .prepare("SELECT folder_name, embedding FROM recording_vec LIMIT 1")
      .get();
    const row = VecRowSchema.parse(rawRow);

    const rawRanked: unknown = db
      .prepare(
        "SELECT folder_name, vec_distance_cosine(embedding, :q) AS d FROM recording_vec ORDER BY d LIMIT 1",
      )
      .get({ ":q": row.embedding });
    const ranked = RankedRowSchema.parse(rawRanked);
    expect(ranked.folder_name).toBe(row.folder_name);
    expect(ranked.d).toBeLessThan(0.001);
    db.close();
  });
});

describe("hybrid RRF cookbook query (cookbook 6, SQL shape)", () => {
  test("kw side returns rows when MATCH hits, via sqlite3 passthrough", async () => {
    // Literal-inlined query — no --param plumbing in the minimal CLI.
    // For dynamic queries the agent uses `$(swrag embed 'text')` shell
    // composition, not query parameters.
    const r = await runSql({
      sql:
        "WITH kw AS (" +
        "  SELECT folder_name, ROW_NUMBER() OVER (ORDER BY bm25(recording_fts)) AS r" +
        "  FROM recording_fts WHERE recording_fts MATCH 'bullmq' LIMIT 50" +
        ") SELECT folder_name, r FROM kw ORDER BY r",
      archive: env.archive,
      sourceDb: env.sourceDb,
      sourceDir: env.sourceDir,
      embedModel: "test-model",
      ollamaHost: "http://127.0.0.1:0",
    });
    expect(r.exitCode).toBe(0);
    const dataLines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(dataLines.length).toBeGreaterThanOrEqual(1);
  });
});
