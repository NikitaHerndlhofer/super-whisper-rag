/**
 * Meeting queue — CRUD layer over the `meeting_queue` table.
 *
 * Every read is parsed through a zod schema so the rest of the meeting
 * pipeline never carries unchecked `unknown` row shapes. Status mutations
 * also bump `updated_at` so listings reflect the true last-change time.
 *
 * "Discard" is intentionally not a separate status — we store it as
 * `status='failed'` with a sentinel error string. Keeping the CHECK
 * constraint to four states (pending / transcribing / completed /
 * failed) makes reasoning about lifecycle states simpler.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";

export const DISCARD_ERROR = "discarded by user";

export const MeetingQueueStatusSchema = z.enum(["pending", "transcribing", "completed", "failed"]);
export type MeetingQueueStatus = z.infer<typeof MeetingQueueStatusSchema>;

export const MeetingQueueRowSchema = z.object({
  id: z.number().int(),
  audio_path: z.string(),
  captured_at: z.string(),
  captured_until: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  label: z.string().nullable(),
  status: MeetingQueueStatusSchema,
  sw_folder_name: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MeetingQueueRow = z.infer<typeof MeetingQueueRowSchema>;

const COUNT_ROW_SCHEMA = z.object({ n: z.number().int() });

export interface EnqueueInput {
  audio_path: string;
  captured_at: string;
  captured_until?: string | null;
  duration_ms?: number | null;
  label?: string | null;
}

/**
 * Insert a new pending row. The `audio_path` UNIQUE constraint guards
 * against accidental double-enqueues; callers should treat the SQLite
 * constraint error as a no-op-or-rethrow decision.
 */
export function enqueue(db: Database, input: EnqueueInput): MeetingQueueRow {
  const result = db
    .prepare(
      `INSERT INTO meeting_queue (audio_path, captured_at, captured_until, duration_ms, label, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      input.audio_path,
      input.captured_at,
      input.captured_until ?? null,
      input.duration_ms ?? null,
      input.label ?? null,
    );
  const id = Number(result.lastInsertRowid);
  const row = getById(db, id);
  if (!row) {
    throw new Error(`enqueue: inserted row ${id} not found on read-back`);
  }
  return row;
}

/**
 * FIFO by `captured_at`, breaking ties on `id`. Returns null if no
 * pending rows are present. The status filter on `pending` makes the
 * call cheap given `meeting_queue_status_idx`.
 */
export function nextPending(db: Database): MeetingQueueRow | null {
  const raw: unknown = db
    .prepare(
      `SELECT id, audio_path, captured_at, captured_until, duration_ms, label,
              status, sw_folder_name, error, created_at, updated_at
         FROM meeting_queue
        WHERE status = 'pending'
        ORDER BY captured_at ASC, id ASC
        LIMIT 1`,
    )
    .get();
  if (raw == null) return null;
  return MeetingQueueRowSchema.parse(raw);
}

export function getById(db: Database, id: number): MeetingQueueRow | null {
  const raw: unknown = db
    .prepare(
      `SELECT id, audio_path, captured_at, captured_until, duration_ms, label,
              status, sw_folder_name, error, created_at, updated_at
         FROM meeting_queue
        WHERE id = ?`,
    )
    .get(id);
  if (raw == null) return null;
  return MeetingQueueRowSchema.parse(raw);
}

export interface ListOpts {
  status?: MeetingQueueStatus | "all";
}

/**
 * Return queue rows. With `status: 'all'` (or undefined), returns every
 * row sorted FIFO. With a specific status, filters and returns FIFO.
 */
export function list(db: Database, opts: ListOpts = {}): MeetingQueueRow[] {
  const status = opts.status ?? "all";
  const sql =
    status === "all"
      ? `SELECT id, audio_path, captured_at, captured_until, duration_ms, label,
                status, sw_folder_name, error, created_at, updated_at
           FROM meeting_queue
          ORDER BY captured_at ASC, id ASC`
      : `SELECT id, audio_path, captured_at, captured_until, duration_ms, label,
                status, sw_folder_name, error, created_at, updated_at
           FROM meeting_queue
          WHERE status = ?
          ORDER BY captured_at ASC, id ASC`;
  const raw: unknown[] = status === "all" ? db.prepare(sql).all() : db.prepare(sql).all(status);
  return raw.map((r) => MeetingQueueRowSchema.parse(r));
}

/** Count rows in `status='pending'`. */
export function countPending(db: Database): number {
  const raw: unknown = db
    .prepare("SELECT COUNT(*) AS n FROM meeting_queue WHERE status = 'pending'")
    .get();
  return COUNT_ROW_SCHEMA.parse(raw).n;
}

/** Rows stuck in `status='transcribing'` (used by processor's crash-recovery scan). */
export function listTranscribing(db: Database): MeetingQueueRow[] {
  return list(db, { status: "transcribing" });
}

export function markTranscribing(db: Database, id: number): void {
  setStatus(db, id, "transcribing", { clearError: true });
}

export function markCompleted(db: Database, id: number, swFolderName: string): void {
  db.prepare(
    `UPDATE meeting_queue
        SET status = 'completed',
            sw_folder_name = ?,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(swFolderName, id);
}

export function markFailed(db: Database, id: number, errorMsg: string): void {
  db.prepare(
    `UPDATE meeting_queue
        SET status = 'failed',
            error = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(errorMsg, id);
}

/**
 * Discard mirrors `markFailed` but uses a sentinel error so the UI can
 * distinguish user-initiated discards from real failures.
 *
 * As of v0.9.1, the production code paths (processor.discard,
 * daemon.undo_last) prefer `removeRow` over `markDiscarded` — successful
 * and user-discarded items are deleted from the queue rather than left
 * behind as `failed` rows. The function stays exported so any
 * downstream caller wanting to "soft-discard" with the sentinel error
 * still has it; nothing in-tree calls it anymore.
 */
export function markDiscarded(db: Database, id: number): void {
  markFailed(db, id, DISCARD_ERROR);
}

/**
 * Delete a single queue row by id. Returns true iff a row was deleted.
 *
 * v0.9.1 policy: rows the user no longer needs in the queue table are
 * deleted, not parked as `failed`. The archive's `recording` table
 * already holds the canonical transcript post-`runIndexFolder`, and
 * "discarded by user" rows are pure clutter.
 */
export function removeRow(db: Database, id: number): boolean {
  const r = db.prepare("DELETE FROM meeting_queue WHERE id = ?").run(id);
  return r.changes > 0;
}

/**
 * Bulk-delete every row with `status='failed'`. Returns the number of
 * rows removed. Backs the v0.9.1 `swrag meeting queue clear-failed`
 * CLI op and the `queue_clear_failed` daemon socket op.
 */
export function deleteFailedRows(db: Database): number {
  const r = db.prepare("DELETE FROM meeting_queue WHERE status = 'failed'").run();
  return r.changes;
}

function setStatus(
  db: Database,
  id: number,
  status: MeetingQueueStatus,
  opts: { clearError?: boolean } = {},
): void {
  if (opts.clearError) {
    db.prepare(
      `UPDATE meeting_queue
          SET status = ?,
              error = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(status, id);
  } else {
    db.prepare(
      `UPDATE meeting_queue
          SET status = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(status, id);
  }
}
