# SQL cookbook

This document is the canonical set of patterns the agent has been taught.
The same cookbook is embedded verbatim in the bundled `SKILL.md` via
`src/skill.ts` — edit there to update both.

> **Defaults.**
>
> - `swrag sql` opens the archive **read-only**. Writes fail.
> - Output is **sqlite3's default list mode** (pipe-separated, no header).
>   For JSON, CSV, or any other mode, see "Other output modes" below.
> - There is **no `embed(:q)`** or `--param`. For semantic search,
>   compose with the shell: `$(swrag embed 'your text')` expands to a
>   `x'…'` blob literal before SQL is parsed.
> - **Always filter `WHERE superseded_by IS NULL`** unless you
>   specifically want to see Super Whisper's reprocessing history.
> - **Modes (`mode_name`) are user-configurable in Super Whisper** — don't
>   hard-code mode names without first checking which ones this user has
>   (recipe 0 below). Filter with `mode_name_lower` (case-insensitive,
>   indexed) once you know the names.

```sql
-- 0. Discover the user's modes (run this first if you don't already
--    know what to filter on).
SELECT mode_name, COUNT(*) AS n
FROM recording
WHERE superseded_by IS NULL
GROUP BY mode_name
ORDER BY n DESC;

-- 1. Today's recordings, newest first
SELECT folder_name, datetime, mode_name, llm_result
FROM recording
WHERE superseded_by IS NULL
  AND date(datetime) = date('now', 'localtime')
ORDER BY datetime DESC;

-- 2. Meeting recordings from the last 7 days
--    (replace 'meeting' with whatever recipe 0 surfaced for this user)
SELECT folder_name, datetime, duration_sec, llm_result
FROM recording
WHERE superseded_by IS NULL
  AND mode_name_lower = 'meeting'
  AND datetime >= datetime('now', '-7 days')
ORDER BY datetime DESC;

-- 3. Keyword search with snippet (FTS5)
--    Inline the user's search term as a string literal.
SELECT r.folder_name, r.datetime, r.mode_name,
       snippet(recording_fts, 1, '«', '»', '…', 10) AS snip,
       bm25(recording_fts) AS bm25
FROM recording_fts
JOIN recording r ON r.rowid = recording_fts.rowid
WHERE recording_fts MATCH 'bullmq'         -- ← user's term goes here
  AND r.superseded_by IS NULL
ORDER BY bm25
LIMIT 10;
-- MATCH syntax: 'bullmq', '"corporate group"', 'notif*', 'bull NEAR queue'

-- 4. Semantic search (any language) — shell composition via swrag embed.
--    Run from a shell:
--      swrag sql "<query below, with $(swrag embed ...) interpolated>"
SELECT r.folder_name, r.datetime, r.mode_name, r.llm_result,
       vec_distance_cosine(v.embedding,
                           $(swrag embed 'how do notifications work')) AS dist
FROM recording_vec v
JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL
ORDER BY dist
LIMIT 10;

-- 5. Semantic + structured filter
SELECT r.folder_name, r.datetime, r.app_name,
       vec_distance_cosine(v.embedding,
                           $(swrag embed 'how do notifications work')) AS dist
FROM recording_vec v
JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL
  AND r.app_name = 'Cursor'
  AND r.mode_name_lower = 'universal'
ORDER BY dist
LIMIT 10;

-- 6. Hybrid retrieval with Reciprocal Rank Fusion (k=60).
--    Capture the search term once so we don't embed twice:
--
--      Q="how do notifications work"
--      QV=$(swrag embed "$Q")
--      swrag sql "$(cat <<SQL
--        WITH kw AS (
--          SELECT recording_fts.rowid AS rid,
--                 ROW_NUMBER() OVER (ORDER BY bm25(recording_fts)) AS r
--          FROM recording_fts
--          WHERE recording_fts MATCH '$Q' LIMIT 50
--        ),
--        vec AS (
--          SELECT folder_name,
--                 ROW_NUMBER() OVER (ORDER BY vec_distance_cosine(embedding, $QV)) AS r
--          FROM recording_vec LIMIT 50
--        )
--        SELECT r.folder_name, r.datetime, r.mode_name, r.llm_result,
--               COALESCE(1.0/(60+kw.r), 0) + COALESCE(1.0/(60+vec.r), 0) AS rrf
--        FROM recording r
--        LEFT JOIN kw  ON kw.rid = r.rowid
--        LEFT JOIN vec USING (folder_name)
--        WHERE r.superseded_by IS NULL
--          AND (kw.r IS NOT NULL OR vec.r IS NOT NULL)
--        ORDER BY rrf DESC LIMIT 10
--      SQL
--      )"

-- 7. Daily dictation volume by mode
SELECT date(datetime) AS day, mode_name, COUNT(*) AS n,
       ROUND(SUM(duration_sec)/60.0, 1) AS minutes
FROM recording
WHERE superseded_by IS NULL
GROUP BY day, mode_name
ORDER BY day DESC, n DESC;

-- 8. Longest recordings
SELECT folder_name, datetime, mode_name,
       ROUND(duration_sec/60.0, 1) AS min, llm_word_count
FROM recording
WHERE superseded_by IS NULL
ORDER BY duration_sec DESC
LIMIT 10;

-- 9. Per-app breakdown
SELECT app_name, COUNT(*) AS n, AVG(duration_sec) AS avg_sec
FROM recording
WHERE superseded_by IS NULL
  AND app_name IS NOT NULL
GROUP BY app_name
ORDER BY n DESC;

-- 10. Preservation stats: how much have we saved from Super Whisper retention?
SELECT
  COUNT(*) AS total_rows,
  SUM(CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END) AS canonical,
  SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS reprocessed_duplicates,
  COUNT(source_deleted_at) AS preserved_after_deletion,
  COUNT(source_audio_lost_at) AS preserved_audio_lost
FROM recording;

-- 11. Recordings in a specific language
SELECT folder_name, datetime, mode_name, substr(llm_result, 1, 80) AS preview
FROM recording
WHERE superseded_by IS NULL
  AND language = 'pt'
ORDER BY datetime DESC;

-- 12. Reprocessing history of a recording (rare; only when the user asks)
SELECT folder_name, datetime, mode_name, model_name, language_model_name,
       superseded_by, superseded_at
FROM recording
WHERE audio_hash = (
  SELECT audio_hash FROM recording WHERE folder_name = '1779143179'
)
ORDER BY datetime;
```

## Semantic search via `swrag embed`

`swrag embed 'text'` calls Ollama once and prints a SQLite blob literal
(`x'…'`) on stdout. The shell substitutes it into your SQL before the
SQL is ever parsed. From `swrag sql`'s perspective the SQL is just a
string with a blob literal in it.

```bash
# Single-shot semantic search:
swrag sql "SELECT folder_name, vec_distance_cosine(embedding,
                                                   $(swrag embed 'hello'))
           FROM recording_vec ORDER BY 2 LIMIT 5"

# Reuse the same vector twice (FTS + vec hybrid):
QV=$(swrag embed 'how do notifications work')
swrag sql "<...query using $QV in two places...>"
```

There is no in-SQL `embed()` function. The composition happens entirely
at the shell layer.

## Other output modes

`swrag sql` always emits sqlite3's default list mode (pipe-separated, no
header). For JSON, CSV, columns, markdown, etc., call `sqlite3`
directly via `swrag path`:

```bash
# JSON
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode json" \
  "SELECT folder_name FROM recording LIMIT 5"

# CSV
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode csv" \
  "<sql>"

# Markdown table for human reading
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode markdown" \
  "<sql>"
```

Named-parameter binding similarly uses sqlite3's own facility:

```bash
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".parameter set :app 'Cursor'" \
  "SELECT folder_name FROM recording WHERE app_name = :app LIMIT 5"
```

## Tips

- **FTS5 syntax.** Wrap phrases in double quotes: `MATCH '"corporate group"'`.
  Use `*` for prefix matching: `notif*`. Combine with `NEAR/3 word`.
- **`LIMIT` is your job.** Output is not auto-limited — this is a local
  DB. Add an explicit `LIMIT` so the agent context doesn't drown in rows.
- **Read-only by default.** `swrag sql` opens via `file:…?mode=ro`. Any
  write SQL fails with sqlite3's "attempt to write a readonly database".
- **Append-only schema.** The archive raises on `DELETE FROM recording`
  (a `BEFORE DELETE` trigger). Use `source_deleted_at` to model "Super
  Whisper deleted this row" rather than actually deleting it.
- **Quoting.** When you inline user-provided strings into SQL via the
  shell, mind your quotes: `swrag sql "WHERE col = 'don''t'"` (double
  the inner single quote, SQL-standard escaping).
