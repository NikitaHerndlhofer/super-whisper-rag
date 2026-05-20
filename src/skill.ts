/**
 * The full `SKILL.md` body, ready to be written to
 *   ~/.cursor/skills/superwhisper-rag/SKILL.md
 *   ~/.claude/skills/superwhisper-rag/SKILL.md
 *
 * The SQL recipes are imported from `docs/sql-cookbook.md` (the single
 * source of truth) and spliced in below. See `extractCookbook()` for the
 * marker contract.
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
import cookbookDoc from "../docs/sql-cookbook.md" with { type: "text" };

const COOKBOOK_START = "<!-- swrag:cookbook:start -->";
const COOKBOOK_END = "<!-- swrag:cookbook:end -->";

/**
 * Pull the SQL recipes block out of `docs/sql-cookbook.md`. The doc
 * delimits it with `<!-- swrag:cookbook:start -->` / `<!-- swrag:cookbook:end -->`
 * HTML comments (invisible when the doc is rendered). Throwing here at
 * module load means a broken doc fails the build before we ship a
 * SKILL.md with a missing cookbook.
 */
function extractCookbook(doc: string): string {
  const start = doc.indexOf(COOKBOOK_START);
  const end = doc.indexOf(COOKBOOK_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `docs/sql-cookbook.md is missing the ${COOKBOOK_START} / ${COOKBOOK_END} markers — cannot build SKILL.md`,
    );
  }
  return doc.slice(start + COOKBOOK_START.length, end).trim();
}

const COOKBOOK = extractCookbook(cookbookDoc);

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
**The CLI takes zero flags of its own.** Output is sqlite3's default
list mode (pipe-separated, no header).

To use any sqlite3 flag, put \`--\` after \`sql\` — everything that
follows is forwarded to sqlite3 verbatim:

\`\`\`bash
swrag sql -- -json     "SELECT folder_name FROM recording LIMIT 5"
swrag sql -- -cmd ".mode markdown" "<sql>"
swrag sql -- -cmd ".parameter set :app 'Cursor'" \\
             "SELECT folder_name FROM recording WHERE app_name = :app LIMIT 5"
\`\`\`

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
bge-m3 (multilingual). Use \`vec_distance_cosine(...)\`. **For long
recordings, this row stores the L2-normalized centroid of the chunk
vectors** — useful for coarse filtering ("which meetings touch topic X").
For precise within-recording retrieval, query the chunk tables below.

\`recording_chunk\` — one row per ~300-word chunk of a long recording
(rows with word count above the configured threshold; default 500).
Columns: \`id\` (INTEGER PK), \`folder_name\`, \`chunk_idx\` (0-based),
\`text\`, \`start_word\`, \`end_word\`, \`word_count\`. Short rows have no
entries here.

\`recording_chunk_vec\` — sqlite-vec virtual table keyed by
\`chunk_id INTEGER PK\` (= \`recording_chunk.id\`). Same 1024-d bge-m3
embedding shape. Join on \`v.chunk_id = c.id\`.

\`recording_chunk_fts\` — FTS5 over chunk text, external-content against
\`recording_chunk\`. Join via the shared rowid (\`recording_chunk_fts.rowid
= recording_chunk.id\`). \`bm25\` over 300-word chunks ranks much sharper
than over 5,000-word transcripts.

> **When to use chunks vs whole-row:** for "find the moment where I said
> X" semantic search or keyword search over long recordings, prefer the
> chunk tables (recipes 13–17). Once a chunk hits, pull \`r.llm_result\`
> for the full transcript — meetings fit comfortably in a single context
> window. For mode/date/app filtering, stick with \`recording\` directly.

\`v_search\` — pre-joined convenience view over the whole-row text +
\`recording_fts\`. Does not include chunks.

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

${COOKBOOK}

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
