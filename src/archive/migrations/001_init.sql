-- Initial archive schema. Idempotent (CREATE … IF NOT EXISTS / CREATE TRIGGER
-- IF NOT EXISTS) so it's safe to re-run against a pre-existing archive.
--
-- Conventions used by later migrations:
--   - `recording` is append-only; a BEFORE DELETE trigger enforces this.
--   - Soft-delete uses `source_deleted_at`; missing audio uses
--     `source_audio_lost_at`.
--   - `recording_fts` is kept in sync via INSERT/UPDATE triggers.
--   - `recording_vec` is populated by the ingester (not FTS-managed).

CREATE TABLE IF NOT EXISTS recording (
  folder_name           TEXT PRIMARY KEY,
  recording_id_hex      TEXT NOT NULL,
  datetime              TEXT NOT NULL,
  duration_ms           REAL NOT NULL,
  duration_sec          REAL GENERATED ALWAYS AS (duration_ms / 1000.0) STORED,
  mode_name             TEXT NOT NULL,
  mode_name_lower       TEXT GENERATED ALWAYS AS (lower(mode_name)) STORED,
  model_key             TEXT,
  model_name            TEXT,
  language_model_key    TEXT,
  language_model_name   TEXT,
  recording_device      TEXT,
  language              TEXT,
  app_name              TEXT,
  app_category          TEXT,
  raw_word_count        INTEGER,
  llm_word_count        INTEGER,
  result                TEXT,
  llm_result            TEXT,
  raw_result            TEXT,
  has_audio             INTEGER NOT NULL DEFAULT 0,
  meta_path             TEXT NOT NULL,
  audio_path            TEXT,
  source_deleted_at     TEXT,
  source_audio_lost_at  TEXT,
  indexed_at            TEXT NOT NULL,
  embed_model           TEXT,
  embed_dim             INTEGER,
  embed_text_hash       TEXT
);

CREATE INDEX IF NOT EXISTS idx_recording_datetime       ON recording(datetime);
CREATE INDEX IF NOT EXISTS idx_recording_mode           ON recording(mode_name_lower);
CREATE INDEX IF NOT EXISTS idx_recording_app            ON recording(app_name);
CREATE INDEX IF NOT EXISTS idx_recording_language       ON recording(language);
CREATE INDEX IF NOT EXISTS idx_recording_source_deleted ON recording(source_deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS recording_fts USING fts5(
  folder_name UNINDEXED,
  llm_result, raw_result, result,
  content='recording', content_rowid='rowid',
  tokenize="porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS recording_ai AFTER INSERT ON recording BEGIN
  INSERT INTO recording_fts(rowid, folder_name, llm_result, raw_result, result)
  VALUES (new.rowid, new.folder_name, new.llm_result, new.raw_result, new.result);
END;

CREATE TRIGGER IF NOT EXISTS recording_au AFTER UPDATE ON recording BEGIN
  INSERT INTO recording_fts(recording_fts, rowid, folder_name, llm_result, raw_result, result)
  VALUES ('delete', old.rowid, old.folder_name, old.llm_result, old.raw_result, old.result);
  INSERT INTO recording_fts(rowid, folder_name, llm_result, raw_result, result)
  VALUES (new.rowid, new.folder_name, new.llm_result, new.raw_result, new.result);
END;

CREATE TRIGGER IF NOT EXISTS recording_no_delete BEFORE DELETE ON recording BEGIN
  SELECT RAISE(ABORT, 'recording is append-only; use source_deleted_at to mark removal');
END;

CREATE VIRTUAL TABLE IF NOT EXISTS recording_vec USING vec0(
  folder_name TEXT PRIMARY KEY,
  embedding  FLOAT[1024]
);

CREATE VIEW IF NOT EXISTS v_search AS
  SELECT r.*, recording_fts.rowid AS fts_rowid
  FROM recording r
  JOIN recording_fts ON r.rowid = recording_fts.rowid;

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
