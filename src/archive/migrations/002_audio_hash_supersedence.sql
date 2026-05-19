-- Reprocessing supersedence.
--
-- Super Whisper lets the user reprocess the same audio through a different
-- mode. The result is a new row with a new id + new folder_name but a
-- byte-identical output.wav. There is no back-reference in the source
-- schema linking the reprocessings together; we recover that linkage by
-- SHA-1 hashing the audio file ourselves.
--
-- After ingest the supersedence pass groups rows by audio_hash, marks all
-- but the latest as superseded, and the embed pass skips superseded rows.
-- The bundled cookbook filters `WHERE superseded_by IS NULL` by default.
--
-- ALTER TABLE ADD COLUMN has no IF NOT EXISTS form in SQLite; the runner
-- tolerates "duplicate column" errors so this migration is idempotent
-- against archives that already gained these columns through the
-- pre-migrations ad-hoc path.

ALTER TABLE recording ADD COLUMN audio_hash    TEXT;
ALTER TABLE recording ADD COLUMN superseded_by TEXT;
ALTER TABLE recording ADD COLUMN superseded_at TEXT;

CREATE INDEX IF NOT EXISTS idx_recording_audio_hash ON recording(audio_hash);
CREATE INDEX IF NOT EXISTS idx_recording_superseded ON recording(superseded_by);
