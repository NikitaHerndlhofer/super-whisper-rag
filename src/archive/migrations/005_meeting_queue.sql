-- Meeting capture queue.
--
-- Phase 1 of the meeting capture pipeline. Stores wav files awaiting
-- transcription by Super Whisper. The processor drains this table FIFO
-- (by captured_at), drives SW one item at a time, patches the resulting
-- SW row's datetime, and targeted-ingests it into the archive.
--
-- The pause/start state for the processor is persisted in the existing
-- `config` key/value table (key = `meeting_queue_state`) — no new table
-- is needed here.
--
-- Status lifecycle:
--   pending      → enqueued, waiting for the processor
--   transcribing → handed off to SW; processor is awaiting completion
--   completed    → SW finished, datetime patched, row ingested
--   failed       → SW timed out, schema-check failed, or user discarded
--
-- A "discarded by user" row is stored as `status='failed'` with a
-- distinguishing `error` string; it is not a separate status so that
-- the four-state CHECK constraint stays simple.

CREATE TABLE IF NOT EXISTS meeting_queue (
  id              INTEGER PRIMARY KEY,
  audio_path      TEXT NOT NULL UNIQUE,
  captured_at     TEXT NOT NULL,
  captured_until  TEXT,
  duration_ms     INTEGER,
  label           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','transcribing','completed','failed')),
  sw_folder_name  TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS meeting_queue_status_idx
  ON meeting_queue(status, captured_at);
