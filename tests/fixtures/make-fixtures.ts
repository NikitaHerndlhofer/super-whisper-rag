#!/usr/bin/env bun
/**
 * Regenerate the test fixtures in this directory.
 *
 * - `superwhisper.sqlite` is a tiny 5-row mock of Super Whisper's own DB.
 *   The columns mirror the real Super Whisper schema as observed at the
 *   time of writing.
 * - `recordings/<folder_name>/meta.json` are the corresponding meta files.
 *   We include one extra meta with no source row (orphan), and one source
 *   row with no meta on disk (to exercise source-deletion behaviour).
 *
 * Run: bun run tests/fixtures/make-fixtures.ts
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

const ROOT = dirname(new URL(import.meta.url).pathname);
const RECORDINGS_DIR = join(ROOT, "recordings");
const DB_PATH = join(ROOT, "superwhisper.sqlite");

interface Fixture {
  folderName: string;
  recordingIdHex: string;
  datetime: string;
  durationMs: number;
  modeName: string;
  modelKey: string;
  modelName: string;
  languageModelKey: string | null;
  languageModelName: string | null;
  recordingDevice: string;
  rawWordCount: number;
  llmWordCount: number;
  result: string;
  llmResult: string;
  rawResult: string;
  language: string;
  appName: string;
  appCategory: string;
  hasAudio: boolean;
  /** When true, write meta.json. When false, simulate Super Whisper having retention-deleted it. */
  writeMeta: boolean;
  /** When true, include the row in superwhisper.sqlite. */
  includeInDb: boolean;
}

const FIXTURES: Fixture[] = [
  {
    folderName: "1779000000",
    recordingIdHex: "abc111",
    datetime: "2026-05-18T08:30:00",
    durationMs: 12_400,
    modeName: "Universal",
    modelKey: "parakeet",
    modelName: "Parakeet 0.6B",
    languageModelKey: "ggml-llama-3-8b",
    languageModelName: "Llama 3 8B",
    recordingDevice: "MacBook Pro Microphone",
    rawWordCount: 21,
    llmWordCount: 19,
    result: "I need to ship the BullMQ notifications fix today.",
    llmResult: "I need to ship the BullMQ notifications fix today.",
    rawResult: "I need to ship the bull MQ notifications fix today",
    language: "en",
    appName: "Cursor",
    appCategory: "developer-tools",
    hasAudio: true,
    writeMeta: true,
    includeInDb: true,
  },
  {
    folderName: "1779000100",
    recordingIdHex: "abc222",
    datetime: "2026-05-17T15:12:33",
    durationMs: 184_000,
    modeName: "Meeting",
    modelKey: "whisper-large-v3",
    modelName: "Whisper Large v3",
    languageModelKey: null,
    languageModelName: null,
    recordingDevice: "AirPods Pro",
    rawWordCount: 412,
    llmWordCount: 388,
    result:
      "We agreed to move the corporate group migration to next sprint. Adam will own the BullMQ queue work.",
    llmResult:
      "We agreed to move the corporate group migration to next sprint. Adam will own the BullMQ queue work.",
    rawResult:
      "we agreed to move the corporate group migration to next sprint adam will own the bull MQ queue work",
    language: "en",
    appName: "Zoom",
    appCategory: "communication",
    hasAudio: false,
    writeMeta: true,
    includeInDb: true,
  },
  {
    folderName: "1779000200",
    recordingIdHex: "abc333",
    datetime: "2026-05-16T09:00:00",
    durationMs: 8_300,
    modeName: "Code",
    modelKey: "parakeet",
    modelName: "Parakeet 0.6B",
    languageModelKey: "ggml-llama-3-8b",
    languageModelName: "Llama 3 8B",
    recordingDevice: "MacBook Pro Microphone",
    rawWordCount: 14,
    llmWordCount: 13,
    result:
      "function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }",
    llmResult:
      "function debounce(fn, ms) {\n  let t;\n  return (...a) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...a), ms);\n  };\n}",
    rawResult:
      "function debounce fn ms let t return dot dot dot a clear timeout t t equals set timeout arrow fn dot dot dot a comma ms",
    language: "en",
    appName: "Cursor",
    appCategory: "developer-tools",
    hasAudio: true,
    writeMeta: true,
    includeInDb: true,
  },
  {
    folderName: "1779000300",
    recordingIdHex: "abc444",
    datetime: "2026-05-15T19:45:11",
    durationMs: 22_100,
    modeName: "Universal",
    modelKey: "parakeet",
    modelName: "Parakeet 0.6B",
    languageModelKey: "ggml-llama-3-8b",
    languageModelName: "Llama 3 8B",
    recordingDevice: "MacBook Pro Microphone",
    rawWordCount: 38,
    llmWordCount: 36,
    result:
      "Como funcionam as notificações para o usuário certo? Acho que está mandando para o admin em vez do owner.",
    llmResult:
      "Como funcionam as notificações para o usuário certo? Acho que está mandando para o admin em vez do owner.",
    rawResult:
      "como funcionam as notificacoes para o usuario certo acho que esta mandando para o admin em vez do owner",
    language: "pt",
    appName: "Slack",
    appCategory: "communication",
    hasAudio: true,
    writeMeta: true,
    includeInDb: true,
  },
  {
    folderName: "1779000400",
    recordingIdHex: "abc555",
    datetime: "2026-05-14T11:22:00",
    durationMs: 17_900,
    modeName: "Speech To Text",
    modelKey: "whisper-large-v3",
    modelName: "Whisper Large v3",
    languageModelKey: null,
    languageModelName: null,
    recordingDevice: "AirPods Pro",
    rawWordCount: 28,
    llmWordCount: 28,
    result: "Recordatorio: revisar el deployment del jueves antes de la standup.",
    llmResult: "Recordatorio: revisar el deployment del jueves antes de la standup.",
    rawResult: "recordatorio revisar el deployment del jueves antes de la standup",
    language: "es",
    appName: "",
    appCategory: "",
    hasAudio: true,
    writeMeta: true,
    includeInDb: true,
  },
  {
    // Source row exists but meta.json deliberately missing → exercises
    // the `source_deleted_at` path on a subsequent run.
    folderName: "1779000500",
    recordingIdHex: "abc666",
    datetime: "2026-05-13T07:00:00",
    durationMs: 5_500,
    modeName: "Universal",
    modelKey: "parakeet",
    modelName: "Parakeet 0.6B",
    languageModelKey: "ggml-llama-3-8b",
    languageModelName: "Llama 3 8B",
    recordingDevice: "MacBook Pro Microphone",
    rawWordCount: 10,
    llmWordCount: 10,
    result: "Quick note to self about the SQL query bug.",
    llmResult: "Quick note to self about the SQL query bug.",
    rawResult: "quick note to self about the SQL query bug",
    language: "en",
    appName: "",
    appCategory: "",
    hasAudio: false,
    writeMeta: false,
    includeInDb: true,
  },
];

async function main() {
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  if (existsSync(RECORDINGS_DIR)) rmSync(RECORDINGS_DIR, { recursive: true });
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  // Mirror Super Whisper's real schema (v3.x): id is a 16-byte BLOB,
  // duration is in milliseconds as DOUBLE, and the transcripts live in
  // a separate FTS5 virtual table keyed by `recordingId`.
  db.exec(`
    CREATE TABLE recording (
      id BLOB PRIMARY KEY,
      datetime TEXT NOT NULL,
      duration REAL NOT NULL,
      modeName TEXT NOT NULL,
      modelKey TEXT,
      modelName TEXT,
      languageModelKey TEXT,
      languageModelName TEXT,
      recordingDevice TEXT,
      rawWordCount INTEGER,
      llmWordCount INTEGER,
      folderName TEXT NOT NULL UNIQUE
    );
    CREATE VIRTUAL TABLE recording_fts USING fts5(
      recordingId, llmResult, rawResult, result,
      tokenize='porter unicode61'
    );
  `);

  const insertRec = db.prepare(`
    INSERT INTO recording (
      id, datetime, duration, modeName, modelKey, modelName,
      languageModelKey, languageModelName, recordingDevice,
      rawWordCount, llmWordCount, folderName
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO recording_fts (recordingId, llmResult, rawResult, result)
    VALUES (?,?,?,?)
  `);

  for (const f of FIXTURES) {
    if (f.includeInDb) {
      const idBlob = idHexToBlob(f.recordingIdHex);
      insertRec.run(
        idBlob,
        f.datetime,
        f.durationMs,
        f.modeName,
        f.modelKey,
        f.modelName,
        f.languageModelKey,
        f.languageModelName,
        f.recordingDevice,
        f.rawWordCount,
        f.llmWordCount,
        f.folderName,
      );
      insertFts.run(idBlob, f.llmResult, f.rawResult, f.result);
    }
    if (f.writeMeta) {
      const folder = join(RECORDINGS_DIR, f.folderName);
      mkdirSync(folder, { recursive: true });
      const meta = {
        version: 2,
        recordingIdHex: f.recordingIdHex,
        datetime: f.datetime,
        durationMs: f.durationMs,
        modeName: f.modeName,
        modelKey: f.modelKey,
        modelName: f.modelName,
        languageModelKey: f.languageModelKey,
        languageModelName: f.languageModelName,
        recordingDevice: f.recordingDevice,
        result: f.result,
        llmResult: f.llmResult,
        rawResult: f.rawResult,
        rawWordCount: f.rawWordCount,
        llmWordCount: f.llmWordCount,
        segments: [{ start: 0, end: f.durationMs / 1000, text: f.result.slice(0, 80) }],
        promptContext: {
          modeContext: { language: f.language },
          applicationContext: {
            name: f.appName,
            category: f.appCategory,
            bundleIdentifier: bundleId(f.appName),
          },
        },
      };
      await writeFile(join(folder, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
      if (f.hasAudio) {
        // Give each fixture's audio a distinct payload so its SHA-1 is
        // unique. Otherwise the supersedence pass would group all
        // empty-file fixtures together and mark all-but-the-latest as
        // superseded — which is correct behaviour but breaks tests that
        // assume one canonical row per fixture.
        await writeFile(join(folder, "output.wav"), Buffer.from(`fixture-audio-${f.folderName}`));
      }
    }
  }

  // Orphan meta: meta on disk without a source row. We don't include this in
  // the canonical FIXTURES because our ingester only ingests rows that
  // appear in the source DB. It's documented as a future test case.

  db.close();
  console.log(`wrote ${DB_PATH} and ${FIXTURES.filter((f) => f.writeMeta).length} recordings`);
}

function bundleId(appName: string): string {
  switch (appName) {
    case "Cursor":
      return "com.todesktop.230313mzl4w4u92";
    case "Slack":
      return "com.tinyspeck.slackmacgap";
    case "Zoom":
      return "us.zoom.xos";
    default:
      return "";
  }
}

/**
 * Convert the fixture's mnemonic hex id (e.g. "abc111") into the 16-byte
 * BLOB that Super Whisper actually stores. Pad to 32 hex chars first.
 */
function idHexToBlob(hex: string): Buffer {
  const padded = hex.padEnd(32, "0");
  return Buffer.from(padded, "hex");
}

await main();
