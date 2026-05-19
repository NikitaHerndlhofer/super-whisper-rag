-- Narrow the FTS5 update trigger and tighten the audio_hash index.
--
-- (a) The original `recording_au` AFTER UPDATE trigger fired on every
--     column change — including `embed_text_hash`, `audio_hash`,
--     `superseded_by`, `indexed_at`, etc. Each non-text-bearing update
--     pointlessly deleted and reinserted the row's full transcript into
--     `recording_fts`. SQLite supports `AFTER UPDATE OF col1, col2` to
--     fire only when text columns actually change.
--
-- (b) The previous `idx_recording_audio_hash` indexed all NULLs as well
--     as values. The supersedence pass only ever scans rows with
--     `audio_hash IS NOT NULL`, so a partial index is strictly better
--     (smaller, faster scan).
--
-- Idempotent: DROP TRIGGER IF EXISTS / DROP INDEX IF EXISTS handle the
-- existing-archive case.

DROP TRIGGER IF EXISTS recording_au;

CREATE TRIGGER IF NOT EXISTS recording_au
AFTER UPDATE OF llm_result, raw_result, result, folder_name
ON recording
BEGIN
  INSERT INTO recording_fts(recording_fts, rowid, folder_name, llm_result, raw_result, result)
  VALUES ('delete', old.rowid, old.folder_name, old.llm_result, old.raw_result, old.result);
  INSERT INTO recording_fts(rowid, folder_name, llm_result, raw_result, result)
  VALUES (new.rowid, new.folder_name, new.llm_result, new.raw_result, new.result);
END;

DROP INDEX IF EXISTS idx_recording_audio_hash;
CREATE INDEX IF NOT EXISTS idx_recording_audio_hash
  ON recording(audio_hash)
  WHERE audio_hash IS NOT NULL;
