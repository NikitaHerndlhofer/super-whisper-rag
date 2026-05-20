# superwhisper-rag

A local-first, append-only archive of your [Super Whisper](https://superwhisper.com)
dictation history with full-text and multilingual semantic search.

`swrag` keeps a private SQLite database in sync with Super Whisper's
recordings, embeds every transcript with `bge-m3` (1024-d, 100+ languages)
via local [Ollama](https://ollama.com), and exposes the whole thing as a
thin [`sqlite3`](https://sqlite.org) wrapper.

Super Whisper is great at capture but doesn't help you find what you've
said later. You can keep the audio history forever — but it piles up on
disk, and there's no semantic search across it. Or you let it
auto-delete — and then it's just gone. Either way, the actual signal —
the transcript, the decision, the moment — is hard to get back to.
`swrag` extracts only the searchable substance into its own small
archive and leaves the audio policy to Super Whisper.

It's useful if you:

- Want to search what you said weeks or months ago — semantically (in any
  language) or by keyword — without scrolling Super Whisper's UI.
- Want an AI agent (Cursor, Claude Code) to be able to look things up in
  your dictation history on demand.
- Want a local, private, queryable history of your voice. No cloud, no
  telemetry, no account.

## Quick taste

```bash
# Today's dictations
swrag sql "SELECT folder_name, datetime, mode_name, llm_result
           FROM recording
           WHERE date(datetime) = date('now','localtime')
             AND superseded_by IS NULL
           ORDER BY datetime DESC"

# Discover the modes you've actually used — modes are user-configurable in
# Super Whisper, so don't assume any particular name exists.
swrag sql "SELECT mode_name, COUNT(*) AS n
           FROM recording
           WHERE superseded_by IS NULL
           GROUP BY mode_name
           ORDER BY n DESC"

# Filter by Super Whisper mode — replace 'meeting' with one of the names
# the previous query showed. `mode_name_lower` is an indexed generated
# column, so case-insensitive matches are cheap.
swrag sql "SELECT folder_name, datetime, duration_sec, llm_result
           FROM recording
           WHERE mode_name_lower = 'meeting'
             AND datetime >= datetime('now','-7 days')
             AND superseded_by IS NULL
           ORDER BY datetime DESC"

# Keyword search with snippets
swrag sql "SELECT r.folder_name, snippet(recording_fts, 1, '«', '»', '…', 5)
           FROM recording_fts JOIN recording r ON r.rowid = recording_fts.rowid
           WHERE recording_fts MATCH 'bullmq' AND r.superseded_by IS NULL
           ORDER BY bm25(recording_fts) LIMIT 10"

# Semantic search — works in any language; the shell composes the embedding
swrag sql "SELECT r.folder_name, r.llm_result,
                  vec_distance_cosine(v.embedding,
                                      $(swrag embed 'how do notifications work')) AS dist
           FROM recording_vec v JOIN recording r USING (folder_name)
           WHERE r.superseded_by IS NULL
           ORDER BY dist LIMIT 10"

# Find the precise moment in a long meeting — chunk-level semantic search
# returns ~300-word windows instead of "this hour-long meeting probably
# talked about it". Recipe 14 in the cookbook joins the full transcript
# back in for context.
swrag sql "SELECT r.folder_name, c.chunk_idx, c.text,
                  vec_distance_cosine(v.embedding,
                                      $(swrag embed 'how do we price the enterprise tier')) AS dist
           FROM recording_chunk_vec v
           JOIN recording_chunk c ON c.id = v.chunk_id
           JOIN recording r ON r.folder_name = c.folder_name
           WHERE r.superseded_by IS NULL
           ORDER BY dist LIMIT 10"
```

See [`docs/sql-cookbook.md`](docs/sql-cookbook.md) for the full set of
recipes.

## Long-form recordings

Meetings are too long for a single embedding to be useful — `bge-m3`'s
~8K-token window silently drops the back half of anything over ~5K
words, and even within budget a single vector averages every topic
into mush. So at ingest, recordings above ~500 words are also split
into ~300-word overlapping windows (sentence- and speaker-boundary-
aware, deterministic, no LLM call) and embedded individually into
`recording_chunk_vec` and `recording_chunk_fts`. The row-level
`recording_vec` still works for coarse filtering — it's now the
L2-normalized centroid of the row's chunks. Once you've found the
chunk, `recording.llm_result` is the full transcript right there for
context. Recipes 13–17 in the cookbook cover the chunk-level patterns.

## Install

macOS + [Homebrew](https://brew.sh). Two commands, end to end:

```bash
brew install NikitaHerndlhofer/tap/superwhisper-rag
swrag bootstrap
```

`brew install` handles the binary and dependencies (Ollama is pulled
in for you). `swrag bootstrap` then does everything else:

1. Starts the Ollama service if it isn't already running.
2. Pulls `bge-m3` if it isn't already pulled (~2 GB, one-time).
3. Indexes your Super Whisper archive (applies schema migrations 1–4,
   chunks any long-form recordings; see above).
4. Installs the hourly background sync (launchd agent).
5. Installs the manual-invocation agent skill for Cursor and Claude Code.
6. Runs `swrag doctor` and prints a summary.

Idempotent — re-run any time to restore the setup to known-good state.
Each step is independently invokable too (`swrag index`,
`swrag enable-sync`, `swrag install-skill`, `swrag doctor`) if you'd
rather pick and choose.

### About the background sync

`swrag bootstrap` installs a launchd agent that runs `swrag index`
hourly and at login, so the archive stays fresh without you thinking
about it. Each run also applies any pending data updaters, so a
`brew upgrade` that ships a new chunker or backfill catches your
existing archive up automatically — no manual reindex. Even without
the agent, every `swrag sql` runs a sub-millisecond mtime-fast-path
ingest before the query, so on-demand freshness is automatic too.

To remove the launchd agent: `swrag disable-sync`. To reinstall it:
`swrag enable-sync` (or just `swrag bootstrap`).

### About the agent skill

`swrag bootstrap` writes `SKILL.md` to both
`~/.cursor/skills/superwhisper-rag/` and
`~/.claude/skills/superwhisper-rag/`. The skill is **manual-invocation
only** — the agent can never reach for it autonomously. To use it, type
`/superwhisper-rag` (Claude Code) or `@superwhisper-rag` (Cursor). See
[`docs/agent-integration.md`](docs/agent-integration.md) for the
guarantee.

To re-install (e.g. after editing it locally): `swrag install-skill`.
Your edits are backed up to `SKILL.md.bak.<timestamp>` first.

### Verify the setup

```bash
swrag doctor
```

Should report 7/7 OK (sqlite3 + custom build + vec extension + Ollama +
archive + data version + chunk coverage).

## Configuration

All have sensible defaults; you shouldn't need to set any of them.

| Variable             | Purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `SWRAG_SOURCE_DIR`   | Super Whisper recordings dir (default `~/Documents/superwhisper`)                    |
| `SWRAG_SOURCE_DB`    | Super Whisper SQLite path                                                            |
| `SWRAG_ARCHIVE`      | Our archive's path                                                                   |
| `SWRAG_OLLAMA_HOST`  | Ollama URL (or `OLLAMA_HOST`; default `http://127.0.0.1:11434`)                      |
| `SWRAG_EMBED_MODEL`  | Embedding model (default `bge-m3`)                                                   |
| `SWRAG_KEEP_ALIVE`   | Ollama `keep_alive` value (default `"15m"` - the model will unload after 15 minutes) |
| `SWRAG_VERBOSE`      | Truthy → verbose stderr logs                                                         |
| `SWRAG_SKIP_EMBED`   | Truthy → text-only ingest, skip the embed pass                                       |
| `SWRAG_SQLITE_DYLIB` | Custom path to `libsqlite3.dylib`                                                    |

## Commands

| Command                               | What it does                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `swrag sql [SQL]`                     | Run SQL via sqlite3 (default: list mode). Omit SQL to open the REPL. Pass `-` to read from stdin. |
| `swrag index`                         | Ingest changes from Super Whisper now.                                                            |
| `swrag bootstrap`                     | One-shot post-install: start ollama, pull `bge-m3`, verify. Safe to re-run.                       |
| `swrag doctor`                        | Verify the environment.                                                                           |
| `swrag path [archive\|sqlite3\|vec0]` | Print a filesystem path. Default: `archive`.                                                      |
| `swrag embed "TEXT"`                  | Print the embedding of `TEXT` as a SQLite blob literal (`x'…'`), for shell composition.           |
| `swrag install-skill`                 | Install the manual-invocation `SKILL.md` to Cursor and Claude Code.                               |
| `swrag enable-sync` / `disable-sync`  | Manage the hourly launchd background sync agent.                                                  |

## Forwarding flags to sqlite3

`swrag sql` itself takes zero flags. To use any sqlite3 flag —
`-json`, `-csv`, `-line`, `-column`, `-box`, `-markdown`, `-cmd "…"`,
`-header`, `-separator`, etc. — put `--` after `sql` and everything
after the `--` is forwarded to sqlite3 verbatim:

```bash
# JSON output
swrag sql -- -json "SELECT folder_name FROM recording LIMIT 5"

# Markdown table for human reading
swrag sql -- -cmd ".mode markdown" "SELECT folder_name, datetime FROM recording LIMIT 5"

# Named parameters (sqlite3's own .parameter set)
swrag sql -- -cmd ".parameter set :app 'Cursor'" \
             "SELECT folder_name FROM recording WHERE app_name = :app LIMIT 5"

# Compose with semantic embeddings (the `swrag embed` trick still works)
swrag sql -- -json "SELECT folder_name,
                           vec_distance_cosine(embedding, $(swrag embed 'hello')) AS d
                    FROM recording_vec ORDER BY d LIMIT 5"
```

If you'd rather bypass `swrag sql` entirely (e.g. to script around it),
`swrag path` exposes the underlying file paths so you can drive sqlite3
yourself:

```bash
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode csv" \
  "SELECT folder_name FROM recording LIMIT 5"
```

## Privacy

- Embeddings go only to `http://127.0.0.1:11434` (or wherever
  `SWRAG_OLLAMA_HOST` points). Verifiable via `swrag doctor`.
- The archive is plain SQLite on your disk. Back up with Time Machine or
  git-crypt; it never leaves your machine on its own.
- Super Whisper's `meta.json` contains your prompts and clipboard nouns.
  The bundled skill instructs the agent not to surface them unless you
  explicitly ask.

## License

MIT — see [LICENSE](LICENSE).
