# superwhisper-rag

A thin `sqlite3` wrapper for your Super Whisper dictation archive.

`swrag` does three things and nothing more:

1. **Keeps a local SQLite archive in sync with Super Whisper.** Append-only,
   so when Super Whisper's retention deletes a recording the archive keeps
   the text, embedding, and metadata forever.
2. **Loads sqlite-vec.** The archive ships with a `recording_vec` virtual
   table holding multilingual `bge-m3` embeddings (1024-d, 100+ languages).
3. **Substitutes `embed(:q)` calls in your SQL.** You write
   `vec_distance_cosine(embedding, embed(:q))`; `swrag` rewrites that to
   `vec_distance_cosine(embedding, x'…')` after calling Ollama once.

That's the entire value-add. Everything else — output formatting, parameter
binding, dot-commands, the REPL — is just `sqlite3`. You can bypass `swrag
sql` entirely and use `sqlite3 "$(swrag path)"` directly.

## Install

```bash
brew install ollama && brew services start ollama
ollama pull bge-m3
brew install NikitaHerndlhofer/tap/superwhisper-rag
```

The archive is created on first use; there is no `setup` step.

```bash
swrag sql "SELECT mode_name, COUNT(*) FROM recording GROUP BY mode_name"
```

If you want the hourly background sync:

```bash
swrag enable-sync       # ~/Library/LaunchAgents/com.superwhisper-rag.sync.plist
```

To teach Cursor or Claude Code about the archive, install the bundled
machine-level **Skill** (writes to both `~/.cursor/skills/` and
`~/.claude/skills/` unconditionally — a runtime that isn't installed
simply never reads the file):

```bash
swrag install-skill
```

The skill is **manual-invocation only**. Its YAML frontmatter carries
[`disable-model-invocation: true`](https://docs.anthropic.com/en/docs/claude-code/skills#restrict-claudes-skill-access)
— Anthropic's runtime-enforced opt-out that removes the skill (and even
its description) from the agent's context. To use it you explicitly
summon it: `@superwhisper-rag` in Cursor, `/superwhisper-rag` in Claude
Code. The agent has no mechanism to reach for it on its own.

## Use

`swrag sql` is a pure passthrough to `sqlite3`. **It takes zero flags.**
SQL is the only argument:

```bash
# Plain query — sqlite3's default list mode (pipe-separated, no header)
swrag sql "SELECT folder_name, datetime, mode_name FROM recording LIMIT 5"

# Read from stdin
swrag sql - << 'SQL'
  SELECT mode_name, COUNT(*) FROM recording GROUP BY mode_name;
SQL

# Keyword search
swrag sql "SELECT r.folder_name, snippet(recording_fts, 1, '<<', '>>', '...', 5)
           FROM recording_fts JOIN recording r ON r.rowid = recording_fts.rowid
           WHERE recording_fts MATCH 'bullmq'
           ORDER BY bm25(recording_fts) LIMIT 10"

# Semantic search — shell composes the embedding into the SQL via `swrag embed`
swrag sql "SELECT r.folder_name, r.datetime, r.llm_result,
                  vec_distance_cosine(v.embedding,
                                      $(swrag embed 'how do notifications work')) AS dist
           FROM recording_vec v JOIN recording r USING (folder_name)
           ORDER BY dist LIMIT 10"

# No query → drops into the sqlite3 REPL with sqlite-vec already loaded
swrag sql
```

Need a non-default output mode, named-parameter binding, or any other
sqlite3 feature? Use `sqlite3` directly via `swrag path` — see
"Going underneath swrag" below. We don't grow flags for things sqlite3
already does.

See [`docs/sql-cookbook.md`](docs/sql-cookbook.md) for the full set of
recipes.

## Configuration via environment

Anything that used to be a global flag is an env var. All have sensible
defaults; you should never need to set any of them.

| Variable             | Purpose                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `SWRAG_SOURCE_DIR`   | Override Super Whisper recordings dir (default `~/Documents/superwhisper`) |
| `SWRAG_SOURCE_DB`    | Override Super Whisper SQLite path                                         |
| `SWRAG_ARCHIVE`      | Override our archive's path                                                |
| `SWRAG_OLLAMA_HOST`  | Override Ollama URL (or `OLLAMA_HOST`)                                     |
| `SWRAG_EMBED_MODEL`  | Override embedding model (default `bge-m3`)                                |
| `SWRAG_KEEP_ALIVE`   | Ollama `keep_alive` value (default `"0"` — unload after each call)         |
| `SWRAG_VERBOSE`      | Truthy → enable verbose stderr logs                                        |
| `SWRAG_SKIP_EMBED`   | Truthy → skip embed pass on ingest (text-only)                             |
| `SWRAG_SQLITE_DYLIB` | Custom path to `libsqlite3.dylib`                                          |

## Going underneath swrag

```bash
# Drive sqlite3 directly — use any of its flags
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode json" \
  "SELECT folder_name FROM recording LIMIT 5"

# Named parameters work via sqlite3's own .parameter set
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".parameter set :app 'Cursor'" \
  "SELECT folder_name FROM recording WHERE app_name = :app LIMIT 5"

# Compose embeddings inline (same `swrag embed` trick)
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  "SELECT folder_name,
          vec_distance_cosine(embedding, $(swrag embed 'hello world')) AS d
   FROM recording_vec ORDER BY d LIMIT 5"
```

## Commands

| Command                               | What it does                                                           |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `swrag sql [SQL]`                     | Run SQL via sqlite3 (or open REPL when SQL omitted).                   |
| `swrag index`                         | Ingest changes from Super Whisper. `SWRAG_SKIP_EMBED=1` skips Ollama.  |
| `swrag doctor`                        | Verify setup (sqlite3 + vec extension + Ollama).                       |
| `swrag path [archive\|sqlite3\|vec0]` | Print a path for shell composition. Default: `archive`.                |
| `swrag embed "TEXT"`                  | Print the embedding as a SQL blob literal (`x'…'`).                    |
| `swrag install-skill`                 | Install the manual-invocation `SKILL.md` to Cursor and/or Claude Code. |
| `swrag enable-sync` / `disable-sync`  | Manage the hourly launchd agent.                                       |

Eight commands. No `setup`, no `stats`, no `export`, no `show`, no
`describe`, no `schema` — they're all expressible as plain SQL.

## How it works

- **Archive location:** `~/Library/Application Support/superwhisper-rag/swrag.sqlite`. Auto-created on first run.
- **Ingestion** (`swrag index` or `swrag sql`'s gap-fill): mtime fast-path against Super Whisper's DB; on change we `sqlite3 .backup` it, read new rows, enrich each with its `meta.json`, upsert, embed any rows whose text hash changed.
- **`embed()` shortcut:** the CLI parses your SQL, finds `embed(:q)` / `embed('text')` calls, computes the embedding once via Ollama, and inlines each call as `x'<hex>'` before handing the SQL to `sqlite3`.
- **Read-only at query time:** `swrag sql` opens the archive as `file:…?mode=ro`. Any write SQL fails with sqlite3's own "attempt to write a readonly database".
- **Append-only writes:** a `BEFORE DELETE` trigger on `recording` raises on any deletion. Super Whisper's retention can fire freely; we set `source_deleted_at` instead.
- **Validation:** env vars, CLI args, `meta.json`, source-DB rows, and Ollama responses are all parsed through [zod](https://github.com/colinhacks/zod) schemas. Zero `as`-casts on `unknown`.

## Privacy

- Embeddings go only to `http://127.0.0.1:11434` (or wherever `SWRAG_OLLAMA_HOST` points).
- `meta.json` includes prompts and clipboard nouns; the opt-in skill instructs the agent not to surface those unless you ask.
- The archive is plain SQLite. Back up with Time Machine, iCloud, or git-crypt.

## Development

```bash
bun install
bun run scripts/fetch-vec-dylibs.ts   # one-time per checkout
bun run tests/fixtures/make-fixtures.ts
bun test
bun run dev sql "SELECT 1"
bun run build                          # produces dist/swrag-darwin-{arm64,x64}.tar.gz
```

## Non-goals

- Not a Super Whisper replacement.
- Not an automation/trigger system (that's [Macrowhisper](https://github.com/ognistik/macrowhisper)).
- No MCP server, no hosted service, no telemetry.
- No custom output formatters — sqlite3 already has all of them.
- No auto-LIMIT, no statement timeout, no setup wizard.

## License

MIT
