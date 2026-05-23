import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SwPatcher, TESTED_SW_SCHEMA, TESTED_SW_VERSIONS } from "../../src/meeting/patcher.ts";

let workDir: string;
let swDbPath: string;
let recordingsDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-patch-"));
  swDbPath = join(workDir, "superwhisper.sqlite");
  recordingsDir = join(workDir, "recordings");
  mkdirSync(recordingsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Build a SW-shaped SQLite with the exact 19 columns the spike captured.
 * We deliberately mirror the spike's documented types so the patcher's
 * schema check passes against this fixture.
 */
function makeSwDb(swDbPath: string): Database {
  const db = new Database(swDbPath, { create: true, readwrite: true });
  const cols = TESTED_SW_SCHEMA.map(([name, type]) => `${name} ${type}`).join(", ");
  db.exec(`CREATE TABLE recording (${cols})`);
  db.exec(`CREATE VIRTUAL TABLE recording_fts USING fts5(
      recordingId, llmResult, rawResult, result, tokenize='porter unicode61'
    )`);
  return db;
}

function insertSwRow(
  db: Database,
  params: {
    folderName: string;
    datetime: string;
    duration: number;
    appVersion: string;
    fromFile?: number;
    result?: string;
  },
): void {
  const id = params.folderName; // SW uses TEXT for id; mock with the folderName
  db.prepare(
    `INSERT INTO recording (
       id, datetime, duration, appVersion, modelKey, modelName,
       languageModelName, recordingDevice, rawWordCount, llmWordCount,
       prompt, processingTime, languageModelProcessingTime, modeName,
       promptContext, folderName, fromFile, createdAt, languageModelKey
     ) VALUES (
       ?, ?, ?, ?, 'm', 'M', 'lm', 'mic', 1, 1,
       '', 0, 0, 'Universal',
       '{}', ?, ?, '2026-05-22 00:00:00.000', ''
     )`,
  ).run(
    id,
    params.datetime,
    params.duration,
    params.appVersion,
    params.folderName,
    params.fromFile ?? 1,
  );
  db.prepare(
    "INSERT INTO recording_fts (recordingId, llmResult, rawResult, result) VALUES (?, '', '', ?)",
  ).run(id, params.result ?? "hello world");
}

async function writeMetaJson(folder: string, datetime: string): Promise<string> {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "meta.json");
  await writeFile(path, JSON.stringify({ datetime, otherField: "preserved" }, null, 2), "utf8");
  return path;
}

describe("meeting/patcher", () => {
  test("validateSchema passes on a fixture with the full 19-column shape", () => {
    const db = makeSwDb(swDbPath);
    db.close();
    const p = new SwPatcher({ swDbPath, swRecordingsDir: recordingsDir });
    try {
      p.validateSchema();
    } finally {
      p.close();
    }
  });

  test("validateSchema throws when a column is missing", () => {
    // Build a smaller SW DB missing `fromFile`.
    const db = new Database(swDbPath, { create: true, readwrite: true });
    db.exec(`CREATE TABLE recording (
      id TEXT, datetime DATETIME, duration DOUBLE, appVersion TEXT, modelKey TEXT,
      modelName TEXT, languageModelName TEXT, recordingDevice TEXT, rawWordCount INTEGER,
      llmWordCount INTEGER, prompt TEXT, processingTime INTEGER,
      languageModelProcessingTime INTEGER, modeName TEXT, promptContext TEXT,
      folderName TEXT, createdAt DATETIME, languageModelKey TEXT
    )`);
    db.close();
    const p = new SwPatcher({ swDbPath, swRecordingsDir: recordingsDir });
    try {
      expect(() => p.validateSchema()).toThrow(/fromFile/i);
    } finally {
      p.close();
    }
  });

  test("validateSchema throws when the table doesn't exist", () => {
    const db = new Database(swDbPath, { create: true, readwrite: true });
    db.close();
    const p = new SwPatcher({ swDbPath, swRecordingsDir: recordingsDir });
    try {
      expect(() => p.validateSchema()).toThrow(/recording.*table/i);
    } finally {
      p.close();
    }
  });

  test("patch updates SW row datetime and rewrites meta.json atomically", async () => {
    const db = makeSwDb(swDbPath);
    insertSwRow(db, {
      folderName: "FOLDER1",
      datetime: "2026-05-22 12:00:00.000",
      duration: 12345,
      appVersion: TESTED_SW_VERSIONS[0],
    });
    db.close();
    const metaPath = await writeMetaJson(join(recordingsDir, "FOLDER1"), "2026-05-22 12:00:00.000");
    const targetIso = "2026-05-21 01:01:15.000";
    const p = new SwPatcher({ swDbPath, swRecordingsDir: recordingsDir, postPatchRecheckMs: 0 });
    try {
      const result = await p.patch("FOLDER1", targetIso);
      expect(result.folderName).toBe("FOLDER1");
      expect(result.versionWarned).toBe(false);
      expect(result.attempts).toBe(1);
    } finally {
      p.close();
    }
    // Verify DB
    const verifyDb = new Database(swDbPath, { readonly: true });
    try {
      const row = verifyDb
        .prepare("SELECT datetime FROM recording WHERE folderName = ?")
        .get("FOLDER1");
      expect(row).toEqual({ datetime: targetIso });
    } finally {
      verifyDb.close();
    }
    // Verify meta.json — preserved other fields, updated datetime
    const meta = await Bun.file(metaPath).json();
    expect(meta.datetime).toBe(targetIso);
    expect(meta.otherField).toBe("preserved");
  });

  test("appVersion outside TESTED_SW_VERSIONS warns but proceeds", async () => {
    const db = makeSwDb(swDbPath);
    insertSwRow(db, {
      folderName: "FOLDER2",
      datetime: "2026-05-22 12:00:00.000",
      duration: 5000,
      appVersion: "99.99.99",
    });
    db.close();
    await writeMetaJson(join(recordingsDir, "FOLDER2"), "2026-05-22 12:00:00.000");

    const p = new SwPatcher({ swDbPath, swRecordingsDir: recordingsDir, postPatchRecheckMs: 0 });
    try {
      const result = await p.patch("FOLDER2", "2026-05-21 00:00:00.000");
      expect(result.versionWarned).toBe(true);
      expect(result.swAppVersion).toBe("99.99.99");
    } finally {
      p.close();
    }
  });

  test("patch throws when the folderName row is missing", async () => {
    const db = makeSwDb(swDbPath);
    db.close();
    const p = new SwPatcher({ swDbPath, swRecordingsDir: recordingsDir });
    try {
      await expect(p.patch("nosuch", "2026-05-22 00:00:00.000")).rejects.toThrow(/not found/i);
    } finally {
      p.close();
    }
  });

  test("patch throws when meta.json is missing", async () => {
    const db = makeSwDb(swDbPath);
    insertSwRow(db, {
      folderName: "FOLDER3",
      datetime: "2026-05-22 12:00:00.000",
      duration: 1000,
      appVersion: TESTED_SW_VERSIONS[0],
    });
    db.close();
    // intentionally do not write meta.json
    const p = new SwPatcher({ swDbPath, swRecordingsDir: recordingsDir, postPatchRecheckMs: 0 });
    try {
      await expect(p.patch("FOLDER3", "2026-05-21 00:00:00.000")).rejects.toThrow(/meta\.json/i);
    } finally {
      p.close();
    }
  });

  test("skipSchemaValidation lets the patcher run against an arbitrary SW shape (test escape)", async () => {
    // Build a minimal table that only has folderName + datetime +
    // appVersion. Use this when fixture data doesn't justify modeling
    // all 19 columns.
    const db = new Database(swDbPath, { create: true, readwrite: true });
    db.exec("CREATE TABLE recording (folderName TEXT, datetime TEXT, appVersion TEXT)");
    db.prepare("INSERT INTO recording (folderName, datetime, appVersion) VALUES (?, ?, ?)").run(
      "F",
      "2026-05-22 00:00:00.000",
      TESTED_SW_VERSIONS[0],
    );
    db.close();
    await writeMetaJson(join(recordingsDir, "F"), "2026-05-22 00:00:00.000");
    const p = new SwPatcher({
      swDbPath,
      swRecordingsDir: recordingsDir,
      skipSchemaValidation: true,
      postPatchRecheckMs: 0,
    });
    try {
      const result = await p.patch("F", "2026-05-21 00:00:00.000");
      expect(result.folderName).toBe("F");
    } finally {
      p.close();
    }
  });

  test("post-patch verify: re-applies if SW clobbers the datetime between attempts", async () => {
    // Build a SW DB + meta.json, then arrange for an external writer
    // to UPDATE the row back to a stale value during the patcher's
    // post-patch sleep window. The patcher should detect the drift,
    // re-apply, and succeed on attempt 2.
    const db = makeSwDb(swDbPath);
    insertSwRow(db, {
      folderName: "RETRY1",
      datetime: "2026-05-22 12:00:00.000",
      duration: 1000,
      appVersion: TESTED_SW_VERSIONS[0],
    });
    db.close();
    await writeMetaJson(join(recordingsDir, "RETRY1"), "2026-05-22 12:00:00.000");
    const targetIso = "2026-05-21 01:01:15.000";

    const p = new SwPatcher({
      swDbPath,
      swRecordingsDir: recordingsDir,
      postPatchRecheckMs: 50,
    });

    // After the first patch lands, schedule an external "SW" UPDATE
    // that clobbers it back. Fires once at ~25 ms so the patcher
    // catches the drift inside the 50 ms sleep window.
    let clobbered = 0;
    const clobberDelay = 25;
    const clobberTimer = setTimeout(() => {
      const w = new Database(swDbPath, { readwrite: true });
      try {
        w.prepare("UPDATE recording SET datetime = ? WHERE folderName = ?").run(
          "2026-05-22 12:00:00.000",
          "RETRY1",
        );
        clobbered += 1;
      } finally {
        w.close();
      }
    }, clobberDelay);

    try {
      const result = await p.patch("RETRY1", targetIso);
      expect(result.attempts).toBeGreaterThanOrEqual(2);
      expect(clobbered).toBe(1);
    } finally {
      clearTimeout(clobberTimer);
      p.close();
    }

    const verifyDb = new Database(swDbPath, { readonly: true });
    try {
      const row = verifyDb
        .prepare("SELECT datetime FROM recording WHERE folderName = ?")
        .get("RETRY1");
      expect(row).toEqual({ datetime: targetIso });
    } finally {
      verifyDb.close();
    }
  });

  test("post-patch verify: throws after exhausting postPatchMaxAttempts", async () => {
    // Persistent clobberer: every UPDATE the patcher makes gets
    // immediately reverted. After `postPatchMaxAttempts` the patcher
    // should give up with a clear error.
    const db = makeSwDb(swDbPath);
    insertSwRow(db, {
      folderName: "RETRY2",
      datetime: "2026-05-22 12:00:00.000",
      duration: 1000,
      appVersion: TESTED_SW_VERSIONS[0],
    });
    db.close();
    await writeMetaJson(join(recordingsDir, "RETRY2"), "2026-05-22 12:00:00.000");
    const targetIso = "2026-05-21 01:01:15.000";

    const p = new SwPatcher({
      swDbPath,
      swRecordingsDir: recordingsDir,
      postPatchRecheckMs: 20,
      postPatchMaxAttempts: 2,
    });

    let clobbers = 0;
    const interval = setInterval(() => {
      const w = new Database(swDbPath, { readwrite: true });
      try {
        const r = w
          .prepare("UPDATE recording SET datetime = ? WHERE folderName = ?")
          .run("2026-05-22 12:00:00.000", "RETRY2");
        if (r.changes > 0) clobbers += 1;
      } finally {
        w.close();
      }
    }, 5);

    try {
      await expect(p.patch("RETRY2", targetIso)).rejects.toThrow(/did not stick.*2 attempts/i);
      expect(clobbers).toBeGreaterThanOrEqual(2);
    } finally {
      clearInterval(interval);
      p.close();
    }
  });
});
