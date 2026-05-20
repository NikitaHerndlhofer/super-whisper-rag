/**
 * Tests for the deterministic chunker in `src/ingest/chunker.ts` and the
 * long-row branch of `embedDirtyRows` in `src/ingest/ingester.ts`.
 *
 * The chunker is a pure function so the bulk of test surface is fast and
 * I/O-free. Ingester integration is exercised via `ensureFresh` against a
 * temp archive with a synthetic 700-word "meeting" row injected.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { z } from "zod";
import {
  chunkText,
  DEFAULT_CHUNK_STRATEGY,
  serializeChunkStrategy,
  wordCountForChunking,
  type ChunkStrategy,
} from "../src/ingest/chunker.ts";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { ensureExtensionCapableSqlite } from "../src/archive/open.ts";
import { vecDylibPath } from "../src/archive/vec-loader.ts";
import { makeEnv, queryOne, stubEmbed, type TestEnv } from "./helpers.ts";

// Bun's `Database.setCustomSQLite()` must be called before ANY
// `new Database(...)` in the process — otherwise Apple's stripped-down
// system SQLite (no loadable-extension support) gets locked in. The
// integration tests below open the Super Whisper source DB before
// `ensureFresh`, so we have to swap in Homebrew's SQLite up front.
ensureExtensionCapableSqlite();

/* -------------------------------------------------------------------------- */
/* Chunker (pure function)                                                    */
/* -------------------------------------------------------------------------- */

function repeatWords(n: number, prefix = "word"): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`${prefix}${i}`);
  return parts.join(" ");
}

describe("chunkText threshold gate", () => {
  test("input below threshold returns []", () => {
    expect(chunkText(repeatWords(499))).toEqual([]);
  });

  test("input at threshold returns ≥ 1 chunk", () => {
    const chunks = chunkText(repeatWords(500));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("empty input returns []", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  test("invalid strategy throws", () => {
    expect(() => chunkText("x", { ...DEFAULT_CHUNK_STRATEGY, size: 0 })).toThrow();
    expect(() => chunkText("x", { ...DEFAULT_CHUNK_STRATEGY, overlap: -1 })).toThrow();
    expect(() =>
      chunkText("x", { ...DEFAULT_CHUNK_STRATEGY, overlap: 500, size: 300 }),
    ).toThrow();
  });
});

describe("chunkText geometry — size, overlap, indices", () => {
  test("chunks fit in [size-window-marginal, size+window]", () => {
    const chunks = chunkText(repeatWords(2000));
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    for (const c of chunks) {
      expect(c.word_count).toBeGreaterThanOrEqual(50); // floor for any non-degenerate split
      expect(c.word_count).toBeLessThanOrEqual(DEFAULT_CHUNK_STRATEGY.size + DEFAULT_CHUNK_STRATEGY.boundaryWindow);
    }
  });

  test("adjacent chunks overlap by overlap words when no boundary present", () => {
    // No punctuation → no sentence boundary → every non-last chunk hits
    // the target end exactly, so overlap is precisely `overlap`.
    const chunks = chunkText(repeatWords(900));
    for (let i = 1; i < chunks.length - 1; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      if (!prev || !cur) throw new Error("missing chunk");
      const overlap = prev.end_word - cur.start_word + 1;
      expect(overlap).toBe(DEFAULT_CHUNK_STRATEGY.overlap);
    }
  });

  test("chunk_idx is 0..n-1 in order, no gaps", () => {
    const chunks = chunkText(repeatWords(1500));
    expect(chunks.map((c) => c.chunk_idx)).toEqual(chunks.map((_c, i) => i));
  });

  test("text equals words joined by single space", () => {
    const chunks = chunkText(repeatWords(700));
    for (const c of chunks) {
      const words = c.text.split(" ");
      expect(words.length).toBe(c.word_count);
      expect(words.length).toBe(c.end_word - c.start_word + 1);
    }
  });

  test("collapses runs of whitespace in source", () => {
    const noisy = "alpha  \n  beta\t\tgamma".repeat(200);
    const chunks = chunkText(noisy);
    if (chunks.length === 0) return;
    for (const c of chunks) {
      expect(c.text).not.toMatch(/  /);
      expect(c.text).not.toMatch(/\t/);
    }
  });
});

describe("chunkText sentence boundary preference", () => {
  test("ends chunk at sentence boundary inside the window", () => {
    // Build 600 words; insert a "sentence ending" at word ~290 (inside
    // the [270, 330] window when target=299). With no other boundaries,
    // the chunker should pick that one over the hard-split at 299.
    const head: string[] = [];
    for (let i = 0; i < 290; i++) head.push(`a${i}`);
    head.push("end."); // word 290 is sentence-final
    for (let i = 291; i < 600; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(290);
  });

  test("hard-splits at target when no boundary in window", () => {
    // Period far outside the window (word 100) — chunker should ignore
    // it and hard-split at target (299 for the first chunk with
    // defaults).
    const head: string[] = [];
    for (let i = 0; i < 100; i++) head.push(`a${i}`);
    head[99] = `${head[99]}.`; // sentence ends at word 99
    for (let i = 100; i < 600; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(299);
  });
});

describe("chunkText abbreviation + decimal robustness", () => {
  test("'Mr.', 'Dr.', 'e.g.' are not sentence boundaries", () => {
    const head: string[] = [];
    for (let i = 0; i < 280; i++) head.push(`a${i}`);
    head.push("Mr."); // word 280
    for (let i = 0; i < 10; i++) head.push(`b${i}`);
    head.push("e.g."); // ~291
    for (let i = 0; i < 10; i++) head.push(`c${i}`);
    head.push("Dr."); // ~302
    for (let i = 0; i < 300; i++) head.push(`d${i}`);
    const chunks = chunkText(head.join(" "));
    // No sentence boundaries should be found in the ±30 window around
    // target=299, so the chunker falls back to hard-split at 299.
    expect(chunks[0]?.end_word).toBe(299);
  });

  test("'3.14' (decimal) is not a sentence boundary", () => {
    const head: string[] = [];
    for (let i = 0; i < 290; i++) head.push(`a${i}`);
    head.push("3.14");
    for (let i = 0; i < 320; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(299);
  });

  test("ellipsis '...' is not a sentence boundary", () => {
    const head: string[] = [];
    for (let i = 0; i < 290; i++) head.push(`a${i}`);
    head.push("...");
    for (let i = 0; i < 320; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(299);
  });

  test("'!' and '?' ARE sentence boundaries", () => {
    const head: string[] = [];
    for (let i = 0; i < 290; i++) head.push(`a${i}`);
    head.push("wait!"); // word 290 is "wait!"
    for (let i = 291; i < 600; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(290);
  });
});

describe("chunkText speaker-turn preference", () => {
  test("prefers speaker boundary over sentence boundary when both are in window", () => {
    // Word 285 ends a sentence; word 288 starts a new "Speaker 1:" turn.
    // Speaker boundary wins → chunk ends at word 287 (Speaker's start - 1).
    const head: string[] = [];
    for (let i = 0; i < 285; i++) head.push(`a${i}`);
    head.push("done."); // word 285 sentence boundary
    head.push("filler1"); // 286
    head.push("filler2"); // 287
    head.push("Speaker"); // 288 ← new turn starts here
    head.push("2:"); // 289
    for (let i = 290; i < 600; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(287);
    // Chunk 1 starts at 288-50 = 238 (overlap retains context across the
    // boundary). The speaker label itself appears inside chunk 1.
    expect(chunks[1]?.start_word).toBe(238);
    expect(chunks[1]?.text).toContain("Speaker 2:");
  });

  test("recognises bracketed '[Speaker N]:' labels (Super Whisper's actual emission)", () => {
    // Same setup as the bare-label test, but using the bracketed format
    // that the user's real meetings use (10 of 12 long rows).
    const head: string[] = [];
    for (let i = 0; i < 285; i++) head.push(`a${i}`);
    head.push("done."); // word 285 sentence boundary
    head.push("filler1"); // 286
    head.push("filler2"); // 287
    head.push("[Speaker"); // 288 ← new turn starts here
    head.push("2]:"); // 289
    for (let i = 290; i < 600; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(287);
    expect(chunks[1]?.text).toContain("[Speaker 2]:");
  });

  test("speaker boundary outside window is ignored", () => {
    // Word 100 starts "Speaker 1:" (far outside window 269–329).
    // Word 290 is "done." (in window).
    // Sentence wins → chunk ends at 290.
    const head: string[] = [];
    for (let i = 0; i < 100; i++) head.push(`a${i}`);
    head.push("Speaker"); // 100
    head.push("1:"); // 101
    for (let i = 102; i < 290; i++) head.push(`a${i}`);
    head.push("done."); // 290
    for (let i = 291; i < 600; i++) head.push(`b${i}`);
    const chunks = chunkText(head.join(" "));
    expect(chunks[0]?.end_word).toBe(290);
  });
});

describe("chunkText marginal-tail merge", () => {
  test("fewer-than-2×overlap net-new tail folds into predecessor", () => {
    // 551 words with defaults (size=300, overlap=50, threshold=500):
    //   Chunk 0: [0..299]      (target 299, hard split, no boundary)
    //   Chunk 1: [250..549]    (target 549, hard split)
    //   Would-be chunk 2: [500..550] (51 words). Net-new = 550-549 = 1.
    //     1 < 2*overlap = 100 → MERGE into chunk 1.
    // Result: 2 chunks, last one ends at word 550 with 301 words.
    const chunks = chunkText(repeatWords(551));
    expect(chunks.length).toBe(2);
    const last = chunks[chunks.length - 1];
    expect(last?.end_word).toBe(550);
    expect(last?.word_count).toBe(301);
  });

  test("non-marginal tail is preserved", () => {
    // 900 words, defaults → multiple chunks with substantial net-new.
    const chunks = chunkText(repeatWords(900));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (!last || !prev) throw new Error("missing chunks");
    expect(last.end_word - prev.end_word).toBeGreaterThanOrEqual(DEFAULT_CHUNK_STRATEGY.overlap);
  });
});

describe("wordCountForChunking precedence", () => {
  test("prefers llm_word_count when llm_result present", () => {
    expect(
      wordCountForChunking({
        llm_result: "hi",
        raw_result: "hi raw",
        llm_word_count: 100,
        raw_word_count: 999,
      }),
    ).toBe(100);
  });

  test("falls back to raw_word_count when llm_result is null", () => {
    expect(
      wordCountForChunking({
        llm_result: null,
        raw_result: "raw text",
        llm_word_count: 0,
        raw_word_count: 42,
      }),
    ).toBe(42);
  });

  test("returns 0 when both are empty", () => {
    expect(
      wordCountForChunking({
        llm_result: null,
        raw_result: null,
        llm_word_count: 5,
        raw_word_count: 5,
      }),
    ).toBe(0);
  });
});

describe("serializeChunkStrategy stability", () => {
  test("identical strategies produce identical strings", () => {
    const a: ChunkStrategy = {
      size: 300,
      overlap: 50,
      threshold: 500,
      boundaryWindow: 30,
      algoVersion: 2,
    };
    const b: ChunkStrategy = {
      algoVersion: 2,
      boundaryWindow: 30,
      threshold: 500,
      overlap: 50,
      size: 300,
    };
    expect(serializeChunkStrategy(a)).toBe(serializeChunkStrategy(b));
  });

  test("different strategies produce different strings", () => {
    const a = serializeChunkStrategy(DEFAULT_CHUNK_STRATEGY);
    const b = serializeChunkStrategy({ ...DEFAULT_CHUNK_STRATEGY, size: 250 });
    expect(a).not.toBe(b);
  });

  test("algoVersion bump produces a different serialized string", () => {
    const a = serializeChunkStrategy(DEFAULT_CHUNK_STRATEGY);
    const b = serializeChunkStrategy({
      ...DEFAULT_CHUNK_STRATEGY,
      algoVersion: DEFAULT_CHUNK_STRATEGY.algoVersion + 1,
    });
    expect(a).not.toBe(b);
  });
});

/* -------------------------------------------------------------------------- */
/* Ingester integration                                                       */
/* -------------------------------------------------------------------------- */

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

/**
 * Inject a synthetic "meeting" row into the source DB so `ensureFresh`
 * picks it up on the next run. The Super Whisper source schema stores
 * metadata in `recording` and transcripts in a separate FTS5 virtual
 * table `recording_fts` keyed by `recordingId` — we insert into both.
 * Then bump the source DB's mtime so the ingester takes the slow path.
 */
function insertLongMeetingIntoSource(opts: {
  folderName: string;
  llmResult: string;
  llmWordCount: number;
}): void {
  const sdb = new Database(env.sourceDb);
  try {
    const idBlob = new TextEncoder().encode(opts.folderName);
    // Source `datetime` is stored as `YYYY-MM-DD HH:MM:SS.sss` per the
    // existing fixtures.
    const datetime = new Date().toISOString().replace("T", " ").replace("Z", "");
    sdb
      .prepare(
        "INSERT INTO recording (id, datetime, duration, modeName, modelName, languageModelName, recordingDevice, rawWordCount, llmWordCount, folderName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        idBlob,
        datetime,
        opts.llmWordCount * 100, // duration ms
        "Meeting",
        "stub-model",
        "stub-llm",
        "stub-device",
        opts.llmWordCount,
        opts.llmWordCount,
        opts.folderName,
      );
    sdb
      .prepare(
        "INSERT INTO recording_fts (recordingId, llmResult, rawResult, result) VALUES (?, ?, ?, ?)",
      )
      .run(idBlob, opts.llmResult, opts.llmResult, opts.llmResult);
  } finally {
    sdb.close();
  }
  const now = new Date();
  const { utimesSync } = require("node:fs");
  utimesSync(env.sourceDb, now, now);
}

function openArchiveReadonly(): Database {
  const db = new Database(env.archive, { readonly: true });
  db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
  return db;
}

const CountRowSchema = z.object({ n: z.number() });
const VecRowSchema = z.object({
  folder_name: z.string(),
  embedding: z.instanceof(Uint8Array),
});

describe("ingester long-row branch", () => {
  test("long row (700 words) produces ≥ 2 chunks; short row produces 0", async () => {
    insertLongMeetingIntoSource({
      folderName: "long_test_1",
      llmResult: repeatWords(700),
      llmWordCount: 700,
    });
    await ensureFresh(defaultOpts());

    const db = openArchiveReadonly();
    try {
      const long = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
        "long_test_1",
      );
      expect(long.n).toBeGreaterThanOrEqual(2);

      // Fixture rows are all short (well under 500 words). None should
      // have chunks.
      const others = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name != ?",
        "long_test_1",
      );
      expect(others.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("centroid in recording_vec is L2-normalized within float32 epsilon", async () => {
    insertLongMeetingIntoSource({
      folderName: "long_test_norm",
      llmResult: repeatWords(900),
      llmWordCount: 900,
    });
    await ensureFresh(defaultOpts());

    const db = openArchiveReadonly();
    try {
      const raw: unknown = db
        .prepare("SELECT folder_name, embedding FROM recording_vec WHERE folder_name = ?")
        .get("long_test_norm");
      const row = VecRowSchema.parse(raw);
      const f32 = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      let sumSq = 0;
      for (let i = 0; i < f32.length; i++) sumSq += (f32[i] ?? 0) ** 2;
      const norm = Math.sqrt(sumSq);
      expect(Math.abs(norm - 1.0)).toBeLessThan(1e-4);
    } finally {
      db.close();
    }
  });

  test("chunk_vec rows share rowid with recording_chunk.id", async () => {
    insertLongMeetingIntoSource({
      folderName: "long_test_join",
      llmResult: repeatWords(800),
      llmWordCount: 800,
    });
    await ensureFresh(defaultOpts());

    const db = openArchiveReadonly();
    try {
      // Both tables should have the same row count for this folder, and
      // a JOIN on id == chunk_id should equal the chunk count.
      const chunks = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
        "long_test_join",
      );
      const joined = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk c JOIN recording_chunk_vec v ON v.chunk_id = c.id WHERE c.folder_name = ?",
        "long_test_join",
      );
      expect(joined.n).toBe(chunks.n);
      expect(joined.n).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  test("FTS5 rowids match chunk ids (no orphan rows)", async () => {
    insertLongMeetingIntoSource({
      folderName: "long_test_fts",
      llmResult: repeatWords(1200),
      llmWordCount: 1200,
    });
    await ensureFresh(defaultOpts());

    const db = openArchiveReadonly();
    try {
      const cnt = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
        "long_test_fts",
      );
      const fts = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk_fts WHERE folder_name = ?",
        "long_test_fts",
      );
      expect(fts.n).toBe(cnt.n);
    } finally {
      db.close();
    }
  });

  test("idempotent re-run does no extra embed work", async () => {
    let calls = 0;
    const trackedFn = async (texts: string[]) => {
      calls++;
      return stubEmbed(texts);
    };
    insertLongMeetingIntoSource({
      folderName: "long_test_idem",
      llmResult: repeatWords(700),
      llmWordCount: 700,
    });
    await ensureFresh({ ...defaultOpts(), embedFn: trackedFn });
    const firstCalls = calls;
    expect(firstCalls).toBeGreaterThan(0);

    // mtime is unchanged → ensureFresh hits the fast path.
    await ensureFresh({ ...defaultOpts(), embedFn: trackedFn });
    expect(calls).toBe(firstCalls);
  });

  test("backfill: existing long row missing chunks is detected and chunked", async () => {
    insertLongMeetingIntoSource({
      folderName: "long_backfill",
      llmResult: repeatWords(800),
      llmWordCount: 800,
    });
    // First run with the long row.
    await ensureFresh(defaultOpts());

    // Simulate the pre-chunking state: nuke all chunk rows and
    // chunk_strategy from the archive directly, leaving the whole-doc
    // vector + embed_text_hash intact (as if this row was ingested under
    // an older binary).
    const w = new Database(env.archive);
    try {
      w.loadExtension(vecDylibPath(), "sqlite3_vec_init");
      w.exec("DELETE FROM recording_chunk_vec");
      w.exec("DELETE FROM recording_chunk");
      w.exec("DELETE FROM config WHERE key = 'chunk_strategy'");
    } finally {
      w.close();
    }

    // Bump source mtime so ensureFresh takes the slow path.
    const now = new Date();
    const { utimesSync } = require("node:fs");
    utimesSync(env.sourceDb, now, now);

    // Re-run → long-row-missing-chunks dirty-detection should pick it
    // up and rechunk.
    await ensureFresh(defaultOpts());

    const db = openArchiveReadonly();
    try {
      const cnt = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
        "long_backfill",
      );
      expect(cnt.n).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  test("chunk_strategy change rechunks long rows; short rows are untouched", async () => {
    insertLongMeetingIntoSource({
      folderName: "long_strategy",
      llmResult: repeatWords(900),
      llmWordCount: 900,
    });
    await ensureFresh(defaultOpts());

    // Read initial chunk count.
    let initialChunks = 0;
    {
      const db = openArchiveReadonly();
      try {
        initialChunks = queryOne(
          db,
          CountRowSchema,
          "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
          "long_strategy",
        ).n;
      } finally {
        db.close();
      }
    }
    expect(initialChunks).toBeGreaterThanOrEqual(2);

    // Mutate the stored chunk_strategy and FTS row count, then bump
    // mtime. The ingester should detect the mismatch and rebuild.
    const w = new Database(env.archive);
    try {
      w.exec(
        "UPDATE config SET value = '{\"size\":250,\"overlap\":40,\"threshold\":500,\"boundaryWindow\":30,\"algoVersion\":99}' WHERE key = 'chunk_strategy'",
      );
    } finally {
      w.close();
    }
    const now = new Date();
    const { utimesSync } = require("node:fs");
    utimesSync(env.sourceDb, now, now);

    await ensureFresh(defaultOpts());

    const db = openArchiveReadonly();
    try {
      // After rechunk under the binary's compiled default, chunk count
      // should match the initial run.
      const after = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
        "long_strategy",
      );
      expect(after.n).toBe(initialChunks);

      // No orphan FTS rows after rebuild.
      const ftsAll = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk_fts",
      );
      const chunksAll = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk",
      );
      expect(ftsAll.n).toBe(chunksAll.n);
    } finally {
      db.close();
    }
  });

  test("updater system: brew-upgrade + unchanged source mtime still backfills chunks", async () => {
    // Regression: this is the brew-upgrade-then-launchd-tick bug.
    //
    // Setup: under a pre-chunking binary the user has long rows in
    // `recording` with valid whole-document embeddings but no
    // `recording_chunk` rows AND no `data_version` config key (because
    // the pre-updater binary didn't write one). The launchd agent
    // ticks: source DB mtime is unchanged, embed model is unchanged,
    // so the fast-path would return immediately and `embedDirtyRows`
    // would never run → chunks would never be created.
    //
    // The updater system fixes this: missing `data_version` is parsed
    // as 0, updater 4 has version 4 > 0, so it runs, `updatersRan`
    // flips true, the fast-path is vetoed, the slow path executes,
    // and the existing "long row missing chunks" dirty-detection rule
    // picks up the row and backfills it.
    //
    // We can't bump the source mtime in this test — the whole point is
    // that the bug surfaces *because* the mtime is unchanged.
    insertLongMeetingIntoSource({
      folderName: "long_brew_upgrade",
      llmResult: repeatWords(800),
      llmWordCount: 800,
    });
    await ensureFresh(defaultOpts());

    // Simulate the post-upgrade pre-backfill state: chunks gone,
    // chunk_strategy gone (so strategy-mismatch detection doesn't fire
    // and confuse the test), data_version gone.
    const w = new Database(env.archive);
    try {
      w.loadExtension(vecDylibPath(), "sqlite3_vec_init");
      w.exec("DELETE FROM recording_chunk_vec");
      w.exec("DELETE FROM recording_chunk");
      w.exec("DELETE FROM config WHERE key IN ('chunk_strategy', 'data_version')");
    } finally {
      w.close();
    }

    // Critical: do NOT bump source mtime. Stored source_mtime_ns
    // already equals the current source mtime (set during the first
    // ensureFresh above), so the mtime fast-path *would* return —
    // unless something else forces the slow path. That something else
    // is the updater system.
    await ensureFresh(defaultOpts());

    const db = openArchiveReadonly();
    try {
      const cnt = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
        "long_brew_upgrade",
      );
      expect(cnt.n).toBeGreaterThanOrEqual(2);

      // And data_version should now be present and current.
      const dv: unknown = db
        .prepare("SELECT value FROM config WHERE key = 'data_version'")
        .get();
      expect(z.object({ value: z.string() }).parse(dv).value).toBe("4");
    } finally {
      db.close();
    }
  });

  test("embed_model change wipes chunk_vec, preserves chunk text rows", async () => {
    insertLongMeetingIntoSource({
      folderName: "long_model_switch",
      llmResult: repeatWords(800),
      llmWordCount: 800,
    });
    await ensureFresh({ ...defaultOpts(), embedModel: "model-A" });

    let chunkTextBefore: string | undefined;
    {
      const db = openArchiveReadonly();
      try {
        const raw: unknown = db
          .prepare(
            "SELECT text FROM recording_chunk WHERE folder_name = ? ORDER BY chunk_idx LIMIT 1",
          )
          .get("long_model_switch");
        chunkTextBefore = z.object({ text: z.string() }).parse(raw).text;
      } finally {
        db.close();
      }
    }
    expect(chunkTextBefore?.length ?? 0).toBeGreaterThan(0);

    const now = new Date();
    const { utimesSync } = require("node:fs");
    utimesSync(env.sourceDb, now, now);
    await ensureFresh({ ...defaultOpts(), embedModel: "model-B" });

    const db = openArchiveReadonly();
    try {
      // Chunk text rows should still be there with the same text.
      const after: unknown = db
        .prepare(
          "SELECT text FROM recording_chunk WHERE folder_name = ? ORDER BY chunk_idx LIMIT 1",
        )
        .get("long_model_switch");
      const afterText = z.object({ text: z.string() }).parse(after).text;
      expect(afterText).toBe(chunkTextBefore);

      // Chunk vec should have one row per chunk under the new model.
      const cnt = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk WHERE folder_name = ?",
        "long_model_switch",
      );
      const vcnt = queryOne(
        db,
        CountRowSchema,
        "SELECT COUNT(*) AS n FROM recording_chunk_vec v JOIN recording_chunk c ON c.id = v.chunk_id WHERE c.folder_name = ?",
        "long_model_switch",
      );
      expect(vcnt.n).toBe(cnt.n);
    } finally {
      db.close();
    }
  });
});
