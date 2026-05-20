# SQL cookbook

This document is the canonical set of patterns the agent has been taught.
The bundled `SKILL.md` imports the recipe block below verbatim via
`src/skill.ts`, so this file is the single source of truth — edits here
propagate to `SKILL.md` at build time. The slice is delimited by the
`swrag:cookbook` HTML comments and must not be removed.

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
> - **Long recordings are chunked**. Rows with a word count above the
>   configured threshold (default 500) are also split into ~300-word
>   chunks in `recording_chunk` + `recording_chunk_vec` + `recording_chunk_fts`.
>   For "find the moment where I said X", use the chunk tables (recipes
>   13–17). For coarse filtering ("which meetings touch topic Y"), the
>   row-level `recording_vec` is the L2-normalized centroid of its
>   chunks. Short rows have a single vector and no chunks — query
>   `recording*` as usual.

<!-- swrag:cookbook:start -->

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

-- 13. Which recordings have chunks? (i.e., which crossed the long-form
--     threshold and got chunked at ingest.) Useful as a sanity check
--     before reaching for chunk-level recipes.
SELECT r.folder_name, r.datetime, r.mode_name, r.llm_word_count,
       COUNT(c.id) AS n_chunks
FROM recording r
LEFT JOIN recording_chunk c ON c.folder_name = r.folder_name
WHERE r.superseded_by IS NULL
GROUP BY r.folder_name
HAVING n_chunks > 0
ORDER BY r.datetime DESC;

-- 14. Best moment per long recording + the full transcript inline.
--     This is the canonical RAG pattern for long-form retrieval:
--     chunks for precise retrieval, full document for context.
--     ~5K-word meetings fit comfortably in a Claude/GPT context window
--     at LIMIT 5.
WITH ranked AS (
  SELECT chunk_id,
         vec_distance_cosine(embedding,
                             $(swrag embed 'how do notifications work')) AS dist
  FROM recording_chunk_vec
  ORDER BY dist LIMIT 50
),
best AS (
  SELECT c.folder_name, c.id AS chunk_id, c.chunk_idx, c.text, ranked.dist,
         ROW_NUMBER() OVER (PARTITION BY c.folder_name ORDER BY ranked.dist) AS rn
  FROM ranked
  JOIN recording_chunk c ON c.id = ranked.chunk_id
)
SELECT r.folder_name, r.datetime, r.mode_name,
       best.chunk_idx AS hit_idx,
       best.text      AS hit_chunk,
       r.llm_result   AS full_transcript,
       best.dist
FROM best
JOIN recording r USING (folder_name)
WHERE best.rn = 1 AND r.superseded_by IS NULL
ORDER BY best.dist LIMIT 5;

-- 15. Chunk + immediate neighbors (lighter context — use when you don't
--     need the full transcript). Returns the hit chunk plus chunk_idx ±1,
--     in order, for the top semantic hit.
WITH hit AS (
  SELECT c.folder_name, c.chunk_idx,
         vec_distance_cosine(v.embedding,
                             $(swrag embed 'how do notifications work')) AS dist
  FROM recording_chunk_vec v
  JOIN recording_chunk c ON c.id = v.chunk_id
  JOIN recording r ON r.folder_name = c.folder_name
  WHERE r.superseded_by IS NULL
  ORDER BY dist LIMIT 1
)
SELECT c.folder_name, c.chunk_idx, c.text
FROM hit, recording_chunk c
WHERE c.folder_name = hit.folder_name
  AND c.chunk_idx BETWEEN hit.chunk_idx - 1 AND hit.chunk_idx + 1
ORDER BY c.chunk_idx;

-- 16. Chunk-level FTS5 keyword search. bm25() over 300-word chunks ranks
--     much sharper than bm25() over 5,000-word transcripts. Returns one
--     row per matching chunk (a meeting can hit multiple times).
SELECT r.folder_name, r.datetime, r.mode_name,
       c.chunk_idx,
       snippet(recording_chunk_fts, 1, '«', '»', '…', 10) AS snip,
       bm25(recording_chunk_fts) AS bm25
FROM recording_chunk_fts
JOIN recording_chunk c ON c.id = recording_chunk_fts.rowid
JOIN recording r ON r.folder_name = c.folder_name
WHERE recording_chunk_fts MATCH 'pricing'    -- ← user's term goes here
  AND r.superseded_by IS NULL
ORDER BY bm25 LIMIT 20;

-- 17. Hybrid retrieval at chunk granularity (RRF, k=60). Combines
--     chunk-level FTS with chunk-level semantic ranking — usually
--     beats either alone on long-form recall.
--
--     Same shell pattern as recipe 6:
--       Q="pricing"
--       QV=$(swrag embed "$Q")
--       swrag sql "$(cat <<SQL
--         WITH kw AS (
--           SELECT recording_chunk_fts.rowid AS chunk_id,
--                  ROW_NUMBER() OVER (ORDER BY bm25(recording_chunk_fts)) AS r
--           FROM recording_chunk_fts
--           WHERE recording_chunk_fts MATCH '$Q' LIMIT 50
--         ),
--         vec AS (
--           SELECT chunk_id,
--                  ROW_NUMBER() OVER (ORDER BY vec_distance_cosine(embedding, $QV)) AS r
--           FROM recording_chunk_vec LIMIT 50
--         )
--         SELECT r.folder_name, r.datetime, c.chunk_idx, c.text,
--                COALESCE(1.0/(60+kw.r), 0) + COALESCE(1.0/(60+vec.r), 0) AS rrf
--         FROM recording_chunk c
--         JOIN recording r ON r.folder_name = c.folder_name
--         LEFT JOIN kw  ON kw.chunk_id  = c.id
--         LEFT JOIN vec ON vec.chunk_id = c.id
--         WHERE r.superseded_by IS NULL
--           AND (kw.r IS NOT NULL OR vec.r IS NOT NULL)
--         ORDER BY rrf DESC LIMIT 10
--       SQL
--       )"

-- 18. Filter-then-retrieve at chunk granularity. Common shape: "in
--     <mode>/<app>/<date range>, find the moment where I said X."
--     Narrow the chunk set on metadata first, then rank — the vector
--     scan only computes distances for chunks that survive the filter.
--     This is the right pattern any time the user couples a structured
--     constraint with a semantic question.
WITH eligible_chunks AS (
  SELECT c.id AS chunk_id, c.folder_name, c.chunk_idx, c.text
  FROM recording_chunk c
  JOIN recording r ON r.folder_name = c.folder_name
  WHERE r.superseded_by IS NULL
    AND r.mode_name_lower = 'meeting'           -- replace with user's mode
    AND r.datetime >= datetime('now', '-90 days')
)
SELECT e.folder_name, e.chunk_idx, e.text,
       vec_distance_cosine(v.embedding,
                           $(swrag embed 'pricing tier discussion')) AS dist
FROM recording_chunk_vec v
JOIN eligible_chunks e ON e.chunk_id = v.chunk_id
ORDER BY dist LIMIT 10;
```

<!-- swrag:cookbook:end -->

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

## Other output modes (and any other sqlite3 flag)

`swrag sql` defaults to sqlite3's `list` mode. For anything else
(`-json`, `-csv`, `-line`, `-column`, `-box`, `-markdown`, `-html`,
`-header`, `-separator`, `-cmd "…"`, etc.), put `--` after `sql` —
everything past the `--` is forwarded to sqlite3 verbatim:

```bash
swrag sql -- -json    "SELECT folder_name FROM recording LIMIT 5"
swrag sql -- -csv     "<sql>"
swrag sql -- -cmd ".mode markdown" "<sql>"
swrag sql -- -box     "<sql>"

# Named-parameter binding via sqlite3's .parameter set
swrag sql -- -cmd ".parameter set :app 'Cursor'" \
             "SELECT folder_name FROM recording WHERE app_name = :app LIMIT 5"
```

If you'd rather bypass `swrag sql` entirely (e.g. when scripting),
`swrag path` exposes the file paths so you can call `sqlite3` yourself:

```bash
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode json" \
  "<sql>"
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
