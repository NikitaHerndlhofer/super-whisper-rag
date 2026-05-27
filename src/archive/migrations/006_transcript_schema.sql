-- v1.1.0: consolidate transcript schema, normalize datetime, and finally
-- finish the v0.9 cleanup that migration 005 was meant to do.
--
-- BACKGROUND ON THE V0.9 CLEANUP REDO
--
-- v0.7.0 shipped `migrations/005_meeting_queue.sql` (creating the
-- `meeting_queue` table and bumping `PRAGMA user_version` to 5).
-- v1.0.0 replaced that file with `005_cleanup_v09.sql` (dropping
-- the table again) without taking a new version number. The
-- migration runner correctly skips any version <= the archive's
-- current `user_version`, so for users who went v0.7 -> v1.0 the
-- new "005" never ran — their archive still has `meeting_queue`
-- and the meeting-pipeline config rows. The "never edit a shipped
-- migration" rule in `migrations.ts` was violated and the runner
-- had no way to catch it.
--
-- v1.1.0 fixes this two ways:
--   1. This migration re-runs the v0.9 cleanup at the next
--      version number that has never been used, so affected
--      archives finally get cleaned up.
--   2. A regression test (`tests/migrations.test.ts`) freezes the
--      sha256 of every shipped migration to make a future repeat
--      fail at CI time.
--
-- BACKGROUND ON THE TRANSCRIPT COLUMNS
--
-- Super Whisper's transcript storage convention has drifted over
-- time. Older builds wrote the LLM-processed text to `llmResult`;
-- newer builds leave that empty and put it in `result`. The raw
-- Scribe (STT) output has always lived in `rawResult`. Our archive
-- mirrors all three columns as-is, but derived state like
-- `llm_word_count` only ever consulted `llm_result` and reported
-- 0 for any recording from a newer SW build.
--
-- The fix is two explicit columns with clear semantics:
--   - `raw_transcript`       — Scribe (STT) output. Always present
--                              for successful recordings. (= `raw_result`.)
--   - `processed_transcript` — LLM post-processing output. NULL when
--                              the mode didn't run LLM. (Derived from
--                              `result` differing from `raw_result`.)
--
-- Both are VIRTUAL generated columns: computed on read, no storage
-- cost, no risk of data drift. The raw `result` / `llm_result` /
-- `raw_result` columns stay untouched so power users can still see
-- exactly what SW wrote.
--
-- The "result != raw_result" check separates LLM modes (where SW
-- writes the LLM output into `result`) from voice-only modes (where
-- SW mirrors `raw_result` into `result`). It captures both old SW
-- (which mirrored `llmResult` into `result` too) and new SW (which
-- writes the LLM output directly to `result`). Voice-only recordings
-- get NULL `processed_transcript`, which is the honest answer — they
-- never had an LLM stage.
--
-- BACKGROUND ON datetime_iso
--
-- SW's `datetime` field has shipped in two formats:
--   "2026-05-27 18:39:33.470"      (space separator, no Z)
--   "2026-05-27T18:39:33.470Z"     (T separator, Z suffix)
-- Lexicographic comparison breaks across the format boundary
-- (`'T' > ' '`), so a raw `ORDER BY datetime` can flip the order of
-- two recordings that crossed a SW upgrade. `datetime_iso` is a
-- virtual generated column that strftime-normalizes both shapes to
-- the same ISO8601 representation. The accompanying index makes
-- ORDER BY / WHERE on it free.

-- (A) Re-do the v0.9 cleanup (see top-of-file rationale).
DROP TABLE IF EXISTS meeting_queue;
DELETE FROM config WHERE key IN (
  'meeting_queue_state',
  'meeting_system_audio_default',
  'meeting_system_audio_ack',
  'meeting_popup_config',
  'signing_identity',
  'meeting_cleanup_mode',
  'meeting_restore_mode'
);

-- (B) Canonical transcript columns. ALTER TABLE ADD COLUMN is
-- inherently non-idempotent in SQLite; the migration runner
-- tolerates "duplicate column" errors so re-running this migration
-- against an archive that already has these columns is a no-op.
ALTER TABLE recording ADD COLUMN raw_transcript TEXT GENERATED ALWAYS AS (
  raw_result
) VIRTUAL;

ALTER TABLE recording ADD COLUMN processed_transcript TEXT GENERATED ALWAYS AS (
  CASE
    WHEN result IS NOT NULL
     AND result != ''
     AND result != raw_result
    THEN result
    ELSE NULL
  END
) VIRTUAL;

-- (C) Word count for processed_transcript. raw_word_count already
-- exists (SW populates it) and is kept untouched. llm_word_count
-- also stays (SW populates it too) but is unreliable on newer SW
-- builds — the cookbook now points users at processed_word_count
-- as the canonical alternative.
--
-- The length / replace trick is SQLite's idiomatic word count. It
-- assumes single-space word boundaries (good enough for SW output,
-- which is sentence-formatted normal text). NULL/empty/voice-only
-- collapses to 0.
ALTER TABLE recording ADD COLUMN processed_word_count INTEGER GENERATED ALWAYS AS (
  CASE
    WHEN result IS NULL
      OR result = ''
      OR result = raw_result
    THEN 0
    ELSE (length(trim(result))
          - length(replace(trim(result), ' ', ''))) + 1
  END
) VIRTUAL;

-- (D) Normalized ISO8601 datetime + index.
ALTER TABLE recording ADD COLUMN datetime_iso TEXT GENERATED ALWAYS AS (
  strftime('%Y-%m-%dT%H:%M:%fZ', datetime)
) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_recording_datetime_iso
  ON recording(datetime_iso);

-- (E) Rebuild `recording_fts` to point at the canonical transcript
-- columns. External-content FTS5 doesn't support ALTER, so the
-- safe pattern is DROP TRIGGER + DROP TABLE + CREATE + rebuild.
-- The rowid mapping is preserved because recording.rowid is
-- invariant across this operation; `('rebuild')` re-derives the
-- FTS data from the content table by selecting the FTS column
-- names from `recording`. Virtual generated columns are
-- queryable, so the rebuild picks them up correctly.
--
-- Backward compat: existing cookbook queries that do
--   WHERE recording_fts MATCH '<term>'
-- continue to work. Previously matched text in `raw_result` and
-- `result` is now indexed under `raw_transcript` and
-- `processed_transcript`, but the MATCH predicate doesn't care
-- which column the token lives in.

DROP TRIGGER IF EXISTS recording_ai;
DROP TRIGGER IF EXISTS recording_au;
DROP TABLE IF EXISTS recording_fts;

CREATE VIRTUAL TABLE recording_fts USING fts5(
  folder_name UNINDEXED,
  raw_transcript,
  processed_transcript,
  content='recording', content_rowid='rowid',
  tokenize="porter unicode61 remove_diacritics 2"
);

INSERT INTO recording_fts(recording_fts) VALUES ('rebuild');

CREATE TRIGGER recording_ai AFTER INSERT ON recording BEGIN
  INSERT INTO recording_fts(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;

-- The UPDATE OF list watches the underlying raw columns the
-- derived ones depend on. UPDATE OF a generated column would
-- never fire anyway (they can't be assigned to), so listing them
-- here would be a no-op. We drop `llm_result` from the list (it
-- no longer feeds the FTS index in the new schema) and keep
-- `raw_result`, `result`, `folder_name`.
CREATE TRIGGER recording_au
AFTER UPDATE OF raw_result, result, folder_name
ON recording
BEGIN
  INSERT INTO recording_fts(recording_fts, rowid, folder_name, raw_transcript, processed_transcript)
  VALUES ('delete', old.rowid, old.folder_name, old.raw_transcript, old.processed_transcript);
  INSERT INTO recording_fts(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;
