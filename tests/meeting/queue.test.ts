import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../../src/archive/open.ts";
import {
  countPending,
  deleteFailedRows,
  DISCARD_ERROR,
  enqueue,
  getById,
  list,
  listTranscribing,
  markCompleted,
  markDiscarded,
  markFailed,
  markTranscribing,
  MeetingQueueRowSchema,
  nextPending,
  removeRow,
} from "../../src/meeting/queue.ts";

let archivePath: string;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-q-"));
  archivePath = join(workDir, "swrag.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function withDb<T>(fn: (db: ReturnType<typeof openArchive>) => T): T {
  const db = openArchive(archivePath, {});
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("meeting/queue", () => {
  test("migration 005 creates the table", () => {
    withDb((db) => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meeting_queue'")
        .all();
      expect(tables.length).toBe(1);
    });
  });

  test("enqueue inserts a pending row and returns it parsed", () => {
    const row = withDb((db) =>
      enqueue(db, {
        audio_path: "/tmp/a.wav",
        captured_at: "2026-05-22T00:00:00.000Z",
        duration_ms: 12345,
        label: "demo",
      }),
    );
    expect(row.status).toBe("pending");
    expect(row.audio_path).toBe("/tmp/a.wav");
    expect(row.duration_ms).toBe(12345);
    expect(row.label).toBe("demo");
    expect(row.id).toBeGreaterThan(0);
    expect(MeetingQueueRowSchema.safeParse(row).success).toBe(true);
  });

  test("UNIQUE on audio_path prevents duplicate enqueues", () => {
    withDb((db) => {
      enqueue(db, { audio_path: "/tmp/a.wav", captured_at: "2026-05-22T00:00:00.000Z" });
      expect(() =>
        enqueue(db, { audio_path: "/tmp/a.wav", captured_at: "2026-05-22T00:00:01.000Z" }),
      ).toThrow();
    });
  });

  test("nextPending returns FIFO by captured_at, breaking ties by id", () => {
    withDb((db) => {
      const r2 = enqueue(db, { audio_path: "/tmp/b.wav", captured_at: "2026-05-22T01:00:00Z" });
      const r1 = enqueue(db, { audio_path: "/tmp/a.wav", captured_at: "2026-05-22T00:00:00Z" });
      const r3 = enqueue(db, { audio_path: "/tmp/c.wav", captured_at: "2026-05-22T00:00:00Z" });
      const first = nextPending(db);
      expect(first?.id).toBe(r1.id);
      markTranscribing(db, r1.id);
      const second = nextPending(db);
      expect(second?.id).toBe(r3.id); // same captured_at, lower id
      markTranscribing(db, r3.id);
      const third = nextPending(db);
      expect(third?.id).toBe(r2.id);
    });
  });

  test("status transitions: pending -> transcribing -> completed", () => {
    withDb((db) => {
      const row = enqueue(db, {
        audio_path: "/tmp/a.wav",
        captured_at: "2026-05-22T00:00:00Z",
      });
      markTranscribing(db, row.id);
      let cur = getById(db, row.id);
      expect(cur?.status).toBe("transcribing");
      markCompleted(db, row.id, "1779000777");
      cur = getById(db, row.id);
      expect(cur?.status).toBe("completed");
      expect(cur?.sw_folder_name).toBe("1779000777");
      expect(cur?.error).toBeNull();
    });
  });

  test("markFailed records the error message", () => {
    withDb((db) => {
      const row = enqueue(db, {
        audio_path: "/tmp/a.wav",
        captured_at: "2026-05-22T00:00:00Z",
      });
      markFailed(db, row.id, "boom");
      const cur = getById(db, row.id);
      expect(cur?.status).toBe("failed");
      expect(cur?.error).toBe("boom");
    });
  });

  test("markDiscarded uses the DISCARD_ERROR sentinel", () => {
    withDb((db) => {
      const row = enqueue(db, {
        audio_path: "/tmp/a.wav",
        captured_at: "2026-05-22T00:00:00Z",
      });
      markDiscarded(db, row.id);
      const cur = getById(db, row.id);
      expect(cur?.status).toBe("failed");
      expect(cur?.error).toBe(DISCARD_ERROR);
    });
  });

  test("list filters by status; countPending reflects pending only", () => {
    withDb((db) => {
      const r1 = enqueue(db, { audio_path: "/tmp/a.wav", captured_at: "2026-05-22T00:00:00Z" });
      const r2 = enqueue(db, { audio_path: "/tmp/b.wav", captured_at: "2026-05-22T01:00:00Z" });
      enqueue(db, { audio_path: "/tmp/c.wav", captured_at: "2026-05-22T02:00:00Z" });
      markCompleted(db, r1.id, "F1");
      markFailed(db, r2.id, "x");

      const all = list(db, { status: "all" });
      expect(all.length).toBe(3);
      const pending = list(db, { status: "pending" });
      expect(pending.length).toBe(1);
      expect(countPending(db)).toBe(1);
      const completed = list(db, { status: "completed" });
      expect(completed.length).toBe(1);
      const failed = list(db, { status: "failed" });
      expect(failed.length).toBe(1);
    });
  });

  test("listTranscribing returns rows in transcribing", () => {
    withDb((db) => {
      const r1 = enqueue(db, { audio_path: "/tmp/a.wav", captured_at: "2026-05-22T00:00:00Z" });
      const r2 = enqueue(db, { audio_path: "/tmp/b.wav", captured_at: "2026-05-22T01:00:00Z" });
      markTranscribing(db, r1.id);
      markTranscribing(db, r2.id);
      const t = listTranscribing(db);
      expect(t.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    });
  });

  test("removeRow deletes the row and returns true; returns false for unknown id", () => {
    withDb((db) => {
      const row = enqueue(db, {
        audio_path: "/tmp/a.wav",
        captured_at: "2026-05-22T00:00:00Z",
      });
      expect(removeRow(db, row.id)).toBe(true);
      expect(getById(db, row.id)).toBeNull();
      // Idempotent re-call returns false (no row to remove).
      expect(removeRow(db, row.id)).toBe(false);
      expect(removeRow(db, 99999)).toBe(false);
    });
  });

  test("deleteFailedRows removes all status='failed' rows, returns count, leaves others alone", () => {
    withDb((db) => {
      const r1 = enqueue(db, { audio_path: "/tmp/a.wav", captured_at: "2026-05-22T00:00:00Z" });
      const r2 = enqueue(db, { audio_path: "/tmp/b.wav", captured_at: "2026-05-22T01:00:00Z" });
      const r3 = enqueue(db, { audio_path: "/tmp/c.wav", captured_at: "2026-05-22T02:00:00Z" });
      const r4 = enqueue(db, { audio_path: "/tmp/d.wav", captured_at: "2026-05-22T03:00:00Z" });
      markFailed(db, r1.id, "boom1");
      markFailed(db, r2.id, "boom2");
      markTranscribing(db, r3.id);
      // r4 stays pending.
      const n = deleteFailedRows(db);
      expect(n).toBe(2);
      expect(getById(db, r1.id)).toBeNull();
      expect(getById(db, r2.id)).toBeNull();
      expect(getById(db, r3.id)?.status).toBe("transcribing");
      expect(getById(db, r4.id)?.status).toBe("pending");
      // A subsequent call with nothing failed returns 0.
      expect(deleteFailedRows(db)).toBe(0);
    });
  });

  test("zod schema rejects a row with an out-of-enum status (parse-side smoke)", () => {
    // The CHECK constraint on `meeting_queue.status` would reject
    // a corrupted DB write at the SQL level, so we instead feed a
    // synthetic shape directly through the schema to assert the zod
    // gate catches drift.
    const result = MeetingQueueRowSchema.safeParse({
      id: 1,
      audio_path: "/tmp/a.wav",
      captured_at: "x",
      captured_until: null,
      duration_ms: null,
      label: null,
      status: "garbage",
      sw_folder_name: null,
      error: null,
      created_at: "x",
      updated_at: "x",
    });
    expect(result.success).toBe(false);
  });
});
