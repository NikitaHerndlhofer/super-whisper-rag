# superwhisper-rag

A local-first, append-only archive of your [Super Whisper](https://superwhisper.com)
dictation history with full-text and multilingual semantic search.

`swrag` keeps a private SQLite database in sync with Super Whisper's
recordings, embeds every transcript with `bge-m3` (1024-d, 100+ languages)
via local [Ollama](https://ollama.com), and exposes the whole thing as a
thin [`sqlite3`](https://sqlite.org) wrapper. Because the archive is
append-only, your dictations stay searchable forever — even after Super
Whisper's retention window deletes them.

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

# Filter by Super Whisper mode — Meetings from the last 7 days.
# (`mode_name_lower` is an indexed generated column; case-insensitive matches
#  are cheap. Other modes you might see: Universal, Code, SQL, Speech To Text…)
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
```

See [`docs/sql-cookbook.md`](docs/sql-cookbook.md) for the full set of
recipes.

## Install

macOS + [Homebrew](https://brew.sh).

```bash
brew install ollama && brew services start ollama
ollama pull bge-m3
brew install NikitaHerndlhofer/tap/superwhisper-rag
```

The archive is auto-created on first use at
`~/Library/Application Support/superwhisper-rag/swrag.sqlite`. Run any
query to populate it:

```bash
swrag sql "SELECT mode_name, COUNT(*) FROM recording GROUP BY mode_name"
```

That's the whole setup.

### Optional — hourly background sync

Without this, the archive updates only when you run a query. With it, a
launchd agent runs `swrag index` every hour and on login:

```bash
swrag enable-sync
```

To remove: `swrag disable-sync`.

### Optional — install the agent skill

If you use Cursor or Claude Code and want them to query the archive on
demand:

```bash
swrag install-skill
```

This writes `SKILL.md` to both `~/.cursor/skills/superwhisper-rag/` and
`~/.claude/skills/superwhisper-rag/`. The skill is **manual-invocation
only** — the agent can never reach for it autonomously. To use it, type `/superwhisper-rag`. See
[`docs/agent-integration.md`](docs/agent-integration.md) for the
guarantee.

### Verify the setup

```bash
swrag doctor
```

Should report 5/5 OK (sqlite3 + custom build + vec extension + Ollama +
archive).

## Configuration

All have sensible defaults; you shouldn't need to set any of them.

| Variable             | Purpose                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SWRAG_SOURCE_DIR`   | Super Whisper recordings dir (default `~/Documents/superwhisper`)                                                      |
| `SWRAG_SOURCE_DB`    | Super Whisper SQLite path                                                                                              |
| `SWRAG_ARCHIVE`      | Our archive's path                                                                                                     |
| `SWRAG_OLLAMA_HOST`  | Ollama URL (or `OLLAMA_HOST`; default `http://127.0.0.1:11434`)                                                        |
| `SWRAG_EMBED_MODEL`  | Embedding model (default `bge-m3`)                                                                                     |
| `SWRAG_KEEP_ALIVE`   | Ollama `keep_alive` value (default `"0"` — unload immediately after each call). Set to e.g. `"5m"` for bulk re-embeds. |
| `SWRAG_VERBOSE`      | Truthy → verbose stderr logs                                                                                           |
| `SWRAG_SKIP_EMBED`   | Truthy → text-only ingest, skip the embed pass                                                                         |
| `SWRAG_SQLITE_DYLIB` | Custom path to `libsqlite3.dylib`                                                                                      |

## Commands

| Command                               | What it does                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `swrag sql [SQL]`                     | Run SQL via sqlite3 (default: list mode). Omit SQL to open the REPL. Pass `-` to read from stdin. |
| `swrag index`                         | Ingest changes from Super Whisper now.                                                            |
| `swrag doctor`                        | Verify the environment.                                                                           |
| `swrag path [archive\|sqlite3\|vec0]` | Print a filesystem path. Default: `archive`.                                                      |
| `swrag embed "TEXT"`                  | Print the embedding of `TEXT` as a SQLite blob literal (`x'…'`), for shell composition.           |
| `swrag install-skill`                 | Install the manual-invocation `SKILL.md` to Cursor and Claude Code.                               |
| `swrag enable-sync` / `disable-sync`  | Manage the hourly launchd background sync agent.                                                  |

## Going underneath swrag

`swrag sql` is a zero-flag passthrough. For sqlite3's other output modes
(`csv`, `json`, `column`, `markdown`, …), named-parameter binding, or any
other sqlite3 feature, call sqlite3 directly via `swrag path`:

```bash
# JSON output
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode json" \
  "SELECT folder_name FROM recording LIMIT 5"

# Named parameters
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".parameter set :app 'Cursor'" \
  "SELECT folder_name FROM recording WHERE app_name = :app LIMIT 5"

# Inline embeddings (same `swrag embed` trick)
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  "SELECT folder_name,
          vec_distance_cosine(embedding, $(swrag embed 'hello world')) AS d
   FROM recording_vec ORDER BY d LIMIT 5"
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
