-- Per-chunk retrieval surface for long recordings.
--
-- Background: today every recording is embedded as a single 1024-d
-- bge-m3 vector. Meetings of ~5K+ words exceed bge-m3's ~8K-token window
-- and Ollama silently truncates the back half. Semantic search over those
-- rows is also blurry by construction: one vector averages every topic
-- discussed across an hour. This migration adds a chunked retrieval
-- surface so long rows are split into ~300-word windows, each with its
-- own embedding + FTS entry.
--
-- The single-vector path is preserved unchanged for short rows. For long
-- rows the `recording_vec` entry is rewritten as the L2-normalized
-- centroid of the chunk vectors, keeping it as a meaningful coarse
-- signal for hybrid retrieval.
--
-- Design notes:
--   - Three tables share one integer rowid. `recording_chunk.id` is
--     INTEGER PRIMARY KEY (aliases rowid). `recording_chunk_vec` declares
--     `chunk_id INTEGER PRIMARY KEY` so vec0 partitions on the same
--     value. `recording_chunk_fts` uses `content_rowid='id'` so its
--     rowid matches. Cookbook recipes are pure JOINs with no string
--     parsing.
--   - vec0 has no foreign-key support, so the ingester DELETEs from
--     `recording_chunk_vec` explicitly before DELETEing matching chunks.
--   - External-content FTS5 does NOT auto-sync on content-table deletes;
--     we maintain it explicitly via the AFTER DELETE trigger below, or
--     `recording_chunk_fts` accumulates orphan rows that bm25() will
--     silently match on phantom chunks.

CREATE TABLE IF NOT EXISTS recording_chunk (
  id           INTEGER PRIMARY KEY,
  folder_name  TEXT NOT NULL REFERENCES recording(folder_name),
  chunk_idx    INTEGER NOT NULL,
  text         TEXT NOT NULL,
  start_word   INTEGER NOT NULL,
  end_word     INTEGER NOT NULL,
  word_count   INTEGER NOT NULL,
  UNIQUE (folder_name, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_recording_chunk_folder
  ON recording_chunk(folder_name);

CREATE VIRTUAL TABLE IF NOT EXISTS recording_chunk_vec USING vec0(
  chunk_id  INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);

CREATE VIRTUAL TABLE IF NOT EXISTS recording_chunk_fts USING fts5(
  folder_name UNINDEXED,
  text,
  content='recording_chunk',
  content_rowid='id',
  tokenize="porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS recording_chunk_ai
AFTER INSERT ON recording_chunk
BEGIN
  INSERT INTO recording_chunk_fts(rowid, folder_name, text)
  VALUES (new.id, new.folder_name, new.text);
END;

-- Narrow to text-only updates (mirrors migration 003's narrowed
-- recording_au). chunk_idx / start_word / end_word changes don't need
-- to invalidate the FTS row.
CREATE TRIGGER IF NOT EXISTS recording_chunk_au
AFTER UPDATE OF text ON recording_chunk
BEGIN
  INSERT INTO recording_chunk_fts(recording_chunk_fts, rowid, folder_name, text)
  VALUES ('delete', old.id, old.folder_name, old.text);
  INSERT INTO recording_chunk_fts(rowid, folder_name, text)
  VALUES (new.id, new.folder_name, new.text);
END;

-- Unlike `recording` (which has BEFORE DELETE ABORT), chunks ARE deleted
-- during rechunk on chunk_strategy / embed_model change. We must issue
-- the FTS5 'delete' magic insert explicitly here, since external-content
-- FTS5 does not auto-sync on the content table's deletes.
CREATE TRIGGER IF NOT EXISTS recording_chunk_ad
AFTER DELETE ON recording_chunk
BEGIN
  INSERT INTO recording_chunk_fts(recording_chunk_fts, rowid, folder_name, text)
  VALUES ('delete', old.id, old.folder_name, old.text);
END;
