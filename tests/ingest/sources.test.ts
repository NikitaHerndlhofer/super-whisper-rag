import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceRecordings } from "../../src/ingest/sources.ts";

/**
 * Regression coverage for the datetime-format bulk-ingest bug.
 *
 * Pre-fix: `WHERE r.datetime > ?` did a raw string compare. Super
 * Whisper stores datetimes as `"YYYY-MM-DD HH:MM:SS"`; the bookmark
 * we save back to `last_indexed_datetime` is a copy of that same
 * value, so the predicate happens to work today. But:
 *
 *   1. SW occasionally migrates to ISO8601 with `T` separator and
 *      trailing `Z` (`"2025-05-18T23:18:42.345Z"`). With either side
 *      using `T` and the other using space, lexicographic comparison
 *      flips: `T` (0x54) > space (0x20), so every row looks "older"
 *      than the bookmark and bulk ingest stalls.
 *   2. Fractional seconds, timezone offsets, etc. further muddy the
 *      string-compare picture.
 *
 * Post-fix: both sides go through SQLite's `datetime()` which
 * canonicalises to `YYYY-MM-DD HH:MM:SS`, so any pair of ISO8601-ish
 * inputs sorts correctly.
 *
 * These tests build a tiny stand-in for Super Whisper's schema (we
 * can't reuse the fixture DB because its datetimes are a known
 * format) and round-trip rows through `readSourceRecordings` with
 * mixed-format bookmarks.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swrag-sources-"));
  dbPath = join(dir, "source.sqlite");
  // Build a minimal SW-shaped schema. We only need the columns
  // `readSourceRecordings` reads.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE recording (
      id TEXT PRIMARY KEY,
      datetime TEXT,
      duration DOUBLE,
      modeName TEXT,
      modelKey TEXT,
      modelName TEXT,
      languageModelKey TEXT,
      languageModelName TEXT,
      recordingDevice TEXT,
      rawWordCount INTEGER,
      llmWordCount INTEGER,
      folderName TEXT
    );
    CREATE TABLE recording_fts (recordingId TEXT, llmResult TEXT, rawResult TEXT, result TEXT);
  `);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insertRow(datetime: string, folder: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO recording (id, datetime, duration, modeName, folderName)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(folder, datetime, 1234.0, "test", folder);
    db.prepare(
      `INSERT INTO recording_fts (recordingId, llmResult, rawResult, result)
       VALUES (?, ?, ?, ?)`,
    ).run(folder, "x", "y", "x y");
  } finally {
    db.close();
  }
}

describe("readSourceRecordings — datetime() normalisation", () => {
  test("identical-format bookmark + rows still works (regression baseline)", () => {
    insertRow("2025-05-18 23:18:42", "a");
    insertRow("2025-05-19 10:00:00", "b");
    const since = "2025-05-19 00:00:00";
    const rows = readSourceRecordings(dbPath, since);
    expect(rows.map((r) => r.folderName)).toEqual(["b"]);
  });

  test("space-separator rows, T-separator bookmark (the failing case pre-fix)", () => {
    insertRow("2025-05-18 23:18:42", "a"); // older than bookmark
    insertRow("2025-05-19 10:00:00", "b"); // newer than bookmark
    // Bookmark in `T` form. Naive string compare:
    //   "2025-05-19 10:00:00" < "2025-05-19T00:00:00" because " " < "T".
    // → row "b" looks older than the bookmark → empty result → ingest stalls.
    const since = "2025-05-19T00:00:00";
    const rows = readSourceRecordings(dbPath, since);
    expect(rows.map((r) => r.folderName)).toEqual(["b"]);
  });

  test("T-separator rows, space-separator bookmark", () => {
    insertRow("2025-05-18T23:18:42Z", "a");
    insertRow("2025-05-19T10:00:00Z", "b");
    const since = "2025-05-19 00:00:00";
    const rows = readSourceRecordings(dbPath, since);
    expect(rows.map((r) => r.folderName)).toEqual(["b"]);
  });

  test("trailing-Z + fractional seconds bookmark is comparable to plain bookmark + plain rows", () => {
    insertRow("2025-05-18 23:18:42", "a");
    insertRow("2025-05-19 10:00:00", "b");
    const since = "2025-05-19T00:00:00.000Z";
    const rows = readSourceRecordings(dbPath, since);
    expect(rows.map((r) => r.folderName)).toEqual(["b"]);
  });

  test("null bookmark reads everything regardless of row format", () => {
    insertRow("2025-05-18 23:18:42", "a");
    insertRow("2025-05-19T10:00:00Z", "b");
    const rows = readSourceRecordings(dbPath, null);
    expect(rows.map((r) => r.folderName).sort()).toEqual(["a", "b"]);
  });
});
