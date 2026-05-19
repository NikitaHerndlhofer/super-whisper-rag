/**
 * The full `SKILL.md` body, ready to be written to
 *   ~/.cursor/skills/superwhisper-rag/SKILL.md
 *   ~/.claude/skills/superwhisper-rag/SKILL.md
 *
 * Frontmatter contract (per Anthropic Agent Skills spec — see
 * https://docs.anthropic.com/en/docs/claude-code/skills):
 *
 *   `name`                          — skill identifier.
 *   `description`                   — shown in the user's `/skills` picker.
 *                                     Does NOT enter the agent's context
 *                                     when `disable-model-invocation` is
 *                                     true, so we can write it freely
 *                                     without risking auto-routing.
 *   `disable-model-invocation: true` — runtime-enforced opt-out from
 *                                     auto-routing. From the docs:
 *                                     "Description not in context, full
 *                                     skill loads when you invoke. (…)
 *                                     This removes the skill from Claude's
 *                                     context entirely."
 *
 * The result: the user explicitly summons the skill (`/superwhisper-rag`
 * in Claude Code, `@superwhisper-rag` in Cursor) and the agent has no
 * mechanism to reach for it on its own — not even the description leaks
 * into its context. Cursor implements the same SKILL.md format and
 * either honours `disable-model-invocation` or ignores it as an unknown
 * field; in the worst case Cursor falls back to "description in context"
 * behaviour, which is still strictly safer than the alternative because
 * the description doesn't beg the agent to use the skill.
 */
export const SKILL_MD = `---
name: superwhisper-rag
description: Query the user's local Super Whisper dictation archive (SQLite + bge-m3 embeddings). Manual invocation only.
disable-model-invocation: true
---

# superwhisper-rag — Super Whisper dictation archive

> Manual invocation only — the frontmatter carries
> \`disable-model-invocation: true\`, which removes this skill's
> description from the agent's context and prevents autonomous loading.
> The user explicitly summons it (\`/superwhisper-rag\` in Claude Code,
> \`@superwhisper-rag\` in Cursor).

The user dictates with Super Whisper. Every recording is archived to a
local SQLite database at
\`~/Library/Application Support/superwhisper-rag/swrag.sqlite\`. The
archive is **append-only** — it survives Super Whisper's retention
deletions, so dictations from months or years ago remain queryable even
after Super Whisper itself has dropped them.

\`swrag\` is a thin wrapper around \`sqlite3\`. Output is whatever sqlite3
produces — no custom envelopes, no row counts, no truncation markers.
**The CLI takes zero flags.** Output format is sqlite3's default (list
mode, pipe-separated, no header). For anything else, call sqlite3
directly via \`swrag path\`.

## How to query

\`\`\`bash
# Pass SQL as a single positional argument.
swrag sql "SELECT folder_name, datetime, mode_name FROM recording LIMIT 5"

# Or read from stdin.
swrag sql - << 'SQL'
  SELECT mode_name, COUNT(*) FROM recording GROUP BY mode_name;
SQL

# Or omit the SQL to drop into the sqlite3 REPL (with vec preloaded).
swrag sql
\`\`\`

For semantic search, compose with \`swrag embed\` via shell expansion —
**there is no \`--param\` flag**:

\`\`\`bash
swrag sql "SELECT folder_name, datetime, llm_result,
                  vec_distance_cosine(v.embedding,
                                      $(swrag embed 'how do notifications work')) AS dist
           FROM recording_vec v JOIN recording r USING (folder_name)
           WHERE r.superseded_by IS NULL
           ORDER BY dist LIMIT 10"
\`\`\`

\`swrag embed 'text'\` runs the embedder once and prints a SQLite blob
literal (\`x'…'\`) on stdout. The shell pastes it directly into your SQL.

## Schema (cheat sheet)

\`recording\` — one row per dictation, append-only:

- \`folder_name\` (PK), \`datetime\` (ISO), \`mode_name\`, \`mode_name_lower\`
- \`duration_ms\`, \`duration_sec\`, \`language\`, \`app_name\`, \`app_category\`
- \`model_name\`, \`language_model_name\`, \`recording_device\`
- \`result\`, \`llm_result\`, \`raw_result\`, \`raw_word_count\`, \`llm_word_count\`
- \`meta_path\`, \`audio_path\`, \`has_audio\`, \`indexed_at\`
- \`source_deleted_at\` — set when Super Whisper deleted the source row
- \`source_audio_lost_at\` — set when the audio file disappeared
- \`audio_hash\` — SHA-1 of \`output.wav\`. Reprocessings of the same audio share this.
- \`superseded_by\` — when a Super Whisper reprocess produced a newer row for
  this audio, this points at the newer row's \`folder_name\`. **Always filter
  \`WHERE superseded_by IS NULL\` by default** — otherwise you'll see older
  reprocessings as duplicates.
- \`superseded_at\` — when we detected the supersedence.

> **Default query template**: every query should include
> \`WHERE superseded_by IS NULL\` unless the user explicitly asks to see
> reprocessing history. Both \`recording_fts\` and \`recording_vec\` may
> contain rows for superseded recordings — only \`recording_vec\` skips them
> (we don't waste embedding calls on duplicates), so for FTS you must filter
> in the join.

\`recording_fts\` — FTS5 over \`llm_result\`, \`raw_result\`, \`result\`. Use
\`MATCH\`, \`snippet()\`, \`bm25()\`.

\`recording_vec\` — sqlite-vec virtual table, \`embedding FLOAT[1024]\` from
bge-m3 (multilingual). Use \`vec_distance_cosine(...)\`.

\`v_search\` — pre-joined convenience view.

## The \`swrag embed\` helper

\`swrag embed 'text'\` prints a SQLite blob literal (\`x'…'\`) of the
embedding to stdout. There is no in-SQL \`embed()\` function; the
**shell** does the substitution before SQL reaches the database. This is
deliberate — \`swrag sql\` does zero parsing of your SQL.

\`\`\`bash
swrag embed 'hello world'
# → x'a1b2c3…'   (4096 hex chars = 2048 bytes = 1024 float32s)
\`\`\`

## Going underneath swrag

\`swrag\` is thin. To drive sqlite3 directly (different output modes,
named-parameter binding, dot-commands, etc.):

\`\`\`bash
sqlite3 "$(swrag path)" \\
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \\
  -cmd ".mode json" \\
  "SELECT folder_name FROM recording LIMIT 5"
\`\`\`

For inline embeddings, same \`swrag embed\` composition trick:

\`\`\`bash
sqlite3 "$(swrag path)" \\
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \\
  "SELECT folder_name,
          vec_distance_cosine(embedding, $(swrag embed 'hello world')) AS d
   FROM recording_vec ORDER BY d LIMIT 5"
\`\`\`

## Cookbook

> Every recipe filters \`superseded_by IS NULL\` so reprocessed duplicates
> don't pollute the result set. Drop that clause only if you specifically
> want to inspect the reprocessing history.

\`\`\`sql
-- 1. Today's recordings, newest first
SELECT folder_name, datetime, mode_name, llm_result
FROM recording
WHERE superseded_by IS NULL
  AND date(datetime) = date('now', 'localtime')
ORDER BY datetime DESC;

-- 2. Meeting recordings from the last 7 days
SELECT folder_name, datetime, duration_sec, llm_result
FROM recording
WHERE superseded_by IS NULL
  AND mode_name_lower = 'meeting'
  AND datetime >= datetime('now', '-7 days')
ORDER BY datetime DESC;

-- 3. Keyword search with snippet (FTS5) — exclude superseded in the join
--    Inline the user's search term as a string literal:
SELECT r.folder_name, r.datetime, r.mode_name,
       snippet(recording_fts, 1, '«', '»', '…', 10) AS snip,
       bm25(recording_fts) AS bm25
FROM recording_fts
JOIN recording r ON r.rowid = recording_fts.rowid
WHERE recording_fts MATCH 'bullmq'    -- ← replace with user's term
  AND r.superseded_by IS NULL
ORDER BY bm25
LIMIT 10;
-- MATCH syntax: 'bullmq', '"corporate group"', 'notif*', 'bull NEAR queue'

-- 4. Semantic search (any language). The shell substitutes $(swrag embed)
--    with x'aabbcc…' before SQL is parsed; the language model never sees
--    a :q placeholder.
SELECT r.folder_name, r.datetime, r.mode_name, r.llm_result,
       vec_distance_cosine(v.embedding,
                           $(swrag embed 'how do notifications work')) AS dist
FROM recording_vec v
JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL
ORDER BY dist
LIMIT 10;
-- The embedded text can be in any language: $(swrag embed 'como funcionam as notificações')

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
--    Run this from a shell where you can set $Q once and reuse it.
--
--      Q="how do notifications work"
--      QV=$(swrag embed "$Q")
--      swrag sql "WITH kw AS (
--                   SELECT recording_fts.rowid AS rid,
--                          ROW_NUMBER() OVER (ORDER BY bm25(recording_fts)) AS r
--                   FROM recording_fts WHERE recording_fts MATCH '$Q' LIMIT 50
--                 ),
--                 vec AS (
--                   SELECT folder_name,
--                          ROW_NUMBER() OVER (ORDER BY vec_distance_cosine(embedding, $QV)) AS r
--                   FROM recording_vec LIMIT 50
--                 )
--                 SELECT r.folder_name, r.datetime, r.mode_name, r.llm_result,
--                        COALESCE(1.0/(60+kw.r), 0) + COALESCE(1.0/(60+vec.r), 0) AS rrf
--                 FROM recording r
--                 LEFT JOIN kw  ON kw.rid = r.rowid
--                 LEFT JOIN vec USING (folder_name)
--                 WHERE r.superseded_by IS NULL
--                   AND (kw.r IS NOT NULL OR vec.r IS NOT NULL)
--                 ORDER BY rrf DESC LIMIT 10"

-- 7. Daily dictation volume by mode
SELECT date(datetime) AS day, mode_name, COUNT(*) AS n,
       ROUND(SUM(duration_sec)/60.0, 1) AS minutes
FROM recording
WHERE superseded_by IS NULL
GROUP BY day, mode_name
ORDER BY day DESC, n DESC;

-- 8. Longest recordings
SELECT folder_name, datetime, mode_name, ROUND(duration_sec/60.0, 1) AS min, llm_word_count
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
  SELECT audio_hash FROM recording WHERE folder_name = :folder
)
ORDER BY datetime;
\`\`\`

## Notes

- FTS5 \`MATCH\` doesn't like raw punctuation. Quote phrases:
  \`MATCH '"corporate group"'\`. Use prefix with \`*\`: \`notif*\`.
- Add an explicit \`LIMIT\` to your queries — this is a local DB but the
  output goes through your context window.
- \`embed()\` calls Ollama. First call after the daemon starts can take a
  few hundred ms.
- The archive is opened read-only via \`file:…?mode=ro\`. Writes fail with
  sqlite3's "attempt to write a readonly database". Indexing runs
  automatically before every query.

## Other commands

- \`swrag index\` — ingest from Super Whisper now.
- \`swrag path [archive|sqlite3|vec0]\` — print a path for shell composition.
- \`swrag embed "text"\` — print an embedding as \`x'…'\` for direct sqlite3 use.
- \`swrag doctor\` — verify setup.
`;
