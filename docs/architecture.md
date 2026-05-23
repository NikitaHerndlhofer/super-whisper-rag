# architecture

`swrag` is **the smallest useful wrapper around `sqlite3`** that adds:

1. A Super Whisper ingester (`swrag index`).
2. An `embed()` substitution layer.
3. A read-only URI + sqlite-vec auto-load for `swrag sql`.

Everything else — output formats, REPL, dot-commands, parameter binding —
is the stock `sqlite3` CLI. We never reimplement what it already does.

## Boundary diagram

```
Super Whisper ──read-only──┐
  ~/.../*.sqlite            │       ┌── ~/Library/Application Support/
                            │       │   superwhisper-rag/swrag.sqlite
                            │       │   (canonical, append-only)
                            ├─►───┤
                            │     swrag index (CLI on demand; per-recording
                            │       │   targeted ingest from the meeting watcher;
                            │       │   ensureFresh() on every `swrag sql`)
                            │       │
  meta.json per recording ──┘       │
                                    │
                          swrag sql QUERY            sqlite3 "$(swrag path)" …
                            │                         │
                            │ (no SQL preprocessing;  │ (no swrag in this path —
                            │  shell handles          │  user does .load themselves)
                            │  $(swrag embed …))      │
                            ▼                         ▼
                  /opt/homebrew/opt/sqlite/bin/sqlite3
                    -cmd ".load <vec0_path> sqlite3_vec_init"
                    file:<archive>?mode=ro
                    "<user's SQL, verbatim>"
                            │
                            ▼
                     stdout → user's terminal
                     stderr → user's terminal
                     exitCode → user's shell
```

## Module map

```
src/
├── cli.ts                  # citty dispatcher
├── sqlite3.ts              # The proxy: find sqlite3, build args, spawn.
├── schemas.ts              # Zod schemas for every external value.
├── paths.ts                # All FS paths (incl. Homebrew sqlite3 binary).
├── config.ts               # Constants + env-variable loader.
├── log.ts                  # stderr logger.
│
├── archive/
│   ├── migrations/         # *.sql files imported as text assets.
│   ├── migrations.ts       # MIGRATIONS array (version + name + sql).
│   ├── migrate.ts          # Runner. Tracks PRAGMA user_version.
│   ├── open.ts             # bun:sqlite open + setCustomSQLite + config helpers.
│   └── vec-loader.ts       # Materialise vec0.dylib to tmpdir (dlopen can't read bunfs).
│
├── ingest/
│   ├── sources.ts          # Read Super Whisper SQL + meta.json (zod-validated).
│   ├── snapshot.ts         # Safe .backup copy of source DB to /tmp.
│   ├── ingester.ts         # ensureFresh() — mtime fast-path + delta ingest + embed batching.
│   └── deletions.ts        # markSourceDeletions, refreshAudioLiveness.
│
├── embed/
│   └── ollama.ts           # embedSync (curl) + embedBatch (fetch). Zod-validated responses.
│
├── commands/
│   ├── sql.ts              # The thin sqlite3 proxy.
│   ├── index.ts            # `swrag index`.
│   ├── doctor.ts           # Env health check (sqlite, vec, ollama, archive, watcher, permissions).
│   ├── path.ts             # `swrag path [archive|sqlite3|vec0]`.
│   ├── embed.ts            # `swrag embed "text"` → x'…'.
│   ├── install-skill.ts    # Write SKILL.md to ~/.cursor and/or ~/.claude.
│   ├── bootstrap.ts        # One-shot post-install orchestrator.
│   └── enable-watcher.ts   # Install/remove the meeting-watcher launchd agents.
│
├── launchd/
│   ├── plist.ts            # XML template.
│   └── install.ts          # launchctl bootstrap / bootout.
│
└── skill.ts                # SKILL.md body. Frontmatter carries
                              `disable-model-invocation: true`, which
                              removes the skill from the agent's context
                              entirely — only the user can invoke it.
```

## Lifecycle of `swrag sql`

1. `cli.ts` parses env vars via `EnvSchema`, resolves paths via `resolvePaths`.
2. `commands/sql.ts::runSql`:
   1. Calls `ensureFresh()` (sub-ms fast-path in the common case; a hard failure here is downgraded to a `warn()` so the query still runs against whatever the archive already has).
   2. Reads the SQL string (positional arg, or stdin when `-` was passed). **No tokenisation, no substitution.** The SQL is opaque to `swrag` from here on.
   3. Builds sqlite3 args:
      - `-bail` to stop on error.
      - `-cmd ".load <vec0_path> sqlite3_vec_init"` so vector functions work.
      - URI: `file:<archive>?mode=ro` — the archive is opened read-only.
      - The user's SQL, verbatim — OR, when the user typed `swrag sql -- …`, the args after `--` are forwarded to sqlite3 verbatim (which is how you ask for JSON/CSV/markdown output, dot-commands, named-parameter binding, etc.).
   4. Spawns `/opt/homebrew/opt/sqlite/bin/sqlite3` and forwards stdout, stderr, and exit code.

If `sql` is empty (or the user typed `swrag sql` with no positional and no `--`), we exec sqlite3 with inherited stdio so the REPL has direct access to the terminal.

Semantic search composes through the shell — see "Why semantic search is shell-composed, not SQL-substituted" below.

## Lifecycle of `swrag index`

`ensureFresh(opts)`:

1. Stat the source DB. If `mtimeNs` matches the stored `source_mtime_ns` and the embed model is unchanged, return the fast path.
2. Open the archive read-write (creates dirs / schema / config rows on first run).
3. If the embed model differs from the last run, wipe `recording_vec` and clear `embed_*` columns (auto-detected from the `embed_model` config key — no flag needed).
4. Snapshot the source DB via `sqlite3 .backup` (or, on failure, retry-loop copy).
5. Read rows newer than `last_indexed_datetime`. Join via `meta.json` for each `folderName` to enrich `app_name`, `language`, etc.
6. Upsert into `recording`. Triggers maintain FTS5.
7. Mark `source_deleted_at` on archive rows whose `folder_name` is no longer in the source AND whose `meta.json` is gone.
8. Refresh `has_audio` and `source_audio_lost_at`.
9. For rows whose `embed_text_hash` or `embed_model` doesn't match, batch through Ollama (32 at a time) and upsert into `recording_vec`.
10. Persist `last_indexed_datetime`, `source_mtime_ns`, `embed_model`, `last_sync_finished_at` in `config`.

## Schema migrations

Schema changes ride a tiny migration runner backed by SQLite's built-in
[`PRAGMA user_version`](https://www.sqlite.org/pragma.html#pragma_user_version).
No external library, no checksums table, no opt-in command — every
`swrag index` (and the per-recording targeted ingest from the meeting watcher) opens the archive read-write,
which runs `runMigrations()` before doing anything else.

### Layout

```
src/archive/
├── migrations/
│   ├── 001_init.sql                       # the original schema
│   └── 002_audio_hash_supersedence.sql    # reprocess detection
├── migrations.ts    # imports the .sql files via `with { type: "text" }`
├── migrate.ts       # the runner; parses statements + tracks user_version
└── open.ts          # calls runMigrations() inside openArchive()
```

### Adding a migration

1. Create `src/archive/migrations/NNN_short_name.sql` where `NNN` is the
   next integer (zero-padded, `003`, `004`, …).
2. Import it in `src/archive/migrations.ts` with
   `import sql from "./migrations/NNN_short_name.sql" with { type: "text" }`.
3. Append `{ version: NNN, name: "short_name", sql }` to the `MIGRATIONS`
   array.

Bun inlines the `.sql` content at build time, so migrations travel
inside the compiled binary — no filesystem reads at runtime, no risk of
the user's machine having a different set of migrations than ours.

### Rules for migration authors

- **Migrations are append-only.** Never edit a published migration; if it
  was wrong, ship a new migration that corrects the state.
- **Be idempotent.** Use `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, etc. `ALTER TABLE ADD COLUMN` has no IF
  NOT EXISTS form, but the runner tolerates "duplicate column" errors so
  archives that gained the column through earlier ad-hoc code can still
  pass through.
- **One transaction per migration.** The runner wraps each migration's
  statements + the `PRAGMA user_version = N` bump in a single
  transaction. A migration that throws halfway rolls back fully — the
  archive never lands in a half-applied state.

### How the runner works

```
1. Read PRAGMA user_version   (0 for a brand-new DB)
2. Filter MIGRATIONS to versions > current, sorted ascending.
3. For each pending migration:
   a. BEGIN TRANSACTION
   b. Split the SQL into statements (respecting BEGIN…END trigger bodies).
   c. Run each statement; swallow "duplicate column" errors.
   d. PRAGMA user_version = <this migration's version>
   e. COMMIT
4. Return { fromVersion, toVersion, applied }
```

The statement splitter (`splitSqlStatements` in `migrate.ts`) tokenises
around top-level `;`, respects `BEGIN`…`END` so trigger bodies stay
intact, and strips `--` line comments first.

### Upgrade compatibility

Existing archives that predate the migration runner (created with the
pre-migration ad-hoc code) have `user_version = 0` even though their
schema is already at v2. On first open with the new binary:

- Migration 001 runs but every statement is a no-op (IF NOT EXISTS on
  tables/indexes/triggers, virtual tables already exist).
- Migration 002 tries `ALTER TABLE ADD COLUMN audio_hash` → fails with
  "duplicate column" → runner swallows the error and continues.
- `PRAGMA user_version` is bumped to 2.

From then on the archive is fully under migration-runner control.

## We never touch macOS's stock sqlite3

macOS ships `/usr/bin/sqlite3`, but it's compiled _without_ loadable
extension support — `.load` is a runtime error there, so sqlite-vec cannot
attach. We sidestep this entirely:

- **`swrag sql` (CLI proxy)** uses `findSqlite3Binary()` in
  `src/sqlite3.ts`, which only checks `/opt/homebrew/opt/sqlite/bin/sqlite3`
  and `/usr/local/opt/sqlite/bin/sqlite3` (Apple Silicon and Intel
  Homebrew prefixes). If neither exists we error with
  `"sqlite3 not found … brew install sqlite"`. We never fall through to
  whatever `sqlite3` happens to be on PATH.
- **`bun:sqlite` (ingester)** uses `Database.setCustomSQLite()` pointed at
  `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` via
  `ensureExtensionCapableSqlite()` in `src/archive/open.ts`. Bun's bundled
  SQLite would also work for our DDL but cannot load sqlite-vec, so we
  swap it for the Homebrew dylib at startup.
- **The Homebrew formula** declares `depends_on "sqlite"`, so the
  extension-capable build is guaranteed installed alongside us. If a user
  somehow removed it after install, `swrag doctor` reports the failure
  immediately.

The same Homebrew sqlite serves both surfaces, and we never let the stock
build into the picture.

## Why we shell out to sqlite3 instead of bun:sqlite

We use both:

- **bun:sqlite** for `swrag index` — fast in-process writes, transactions, prepared statements.
- **sqlite3 CLI** for `swrag sql` — its output formatters (`-csv`, `-json`, `-line`, `-column`, `-box`, `-markdown`, …) are battle-tested. We were never going to do them better. And the REPL is a feature for free.

The two share the **same `vec0.dylib`** (materialised once to tmpdir) and the **same `libsqlite3.dylib`** (Homebrew's). The Homebrew formula declares `sqlite` as a dependency, so the CLI is always present.

## Why semantic search is shell-composed, not SQL-substituted

Earlier iterations of `swrag sql` parsed SQL and substituted `embed(:q)`
calls in-place. That required a SQL tokenizer, a parameter-binding layer
(`--param`), and ongoing maintenance of an `embed()` pseudo-function the
agent had to learn.

The minimal CLI does none of that. Semantic search composes through the
shell:

```bash
swrag sql "SELECT folder_name, vec_distance_cosine(embedding,
                                                   $(swrag embed 'hello'))
           FROM recording_vec ORDER BY 2 LIMIT 5"
```

`swrag embed 'text'` calls Ollama once and prints `x'aabbcc…'` (the bge-m3
vector as a SQLite blob literal) on stdout. The shell expands it into
the SQL string before `swrag sql` ever sees it. From `swrag sql`'s
perspective the SQL is just an opaque string with a blob literal in it —
no parsing, no substitution.

Net win: `swrag sql` does **zero** preprocessing of the user's SQL. It's
the thinnest possible wrapper around `sqlite3`.

## Ollama model lifecycle

Every embed request we send to Ollama includes `keep_alive: "15m"` by
default. Ollama interprets that as "keep the model resident in GPU/RAM
for 15 minutes after this call" — which means:

1. The first call after an idle period cold-loads bge-m3 (~5–15 s).
2. Every call inside the next 15 minutes returns in ~100 ms.
3. After 15 minutes of inactivity Ollama unloads the model on its own.

This is a deliberate compromise between snappy interactive search (you
want a hot model when you fire off two or three queries in a row) and
not pinning ~2 GB of GPU/RAM forever just because you used `swrag` once.

Override via `SWRAG_KEEP_ALIVE` when the defaults don't fit:

```bash
# Bulk re-embed, keep the model warm for an hour
SWRAG_KEEP_ALIVE="1h" swrag index

# Privacy-conscious one-shot: unload immediately after each call
SWRAG_KEEP_ALIVE="0" swrag embed "hello"
```

The env var accepts anything Ollama's API does: `"0"`, `"30s"`, `"5m"`,
`"1h"`, `"-1"` for indefinite. See
[Ollama's FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately).

## Super Whisper reprocessing → supersedence

Super Whisper lets the user reprocess the same audio through a different
mode. The result is **a new row with a new `id` and a new `folder_name`**,
**but the same `output.wav` content** (byte-identical, just copied to the
new folder). Super Whisper provides no back-reference linking the
reprocessings together.

We detect this by SHA-1 hashing `output.wav` at ingest time and storing it
on `recording.audio_hash`. The supersedence pass then:

1. Groups rows by `audio_hash`.
2. Picks the row with the latest `datetime` as canonical.
3. Sets `superseded_by = <canonical folder>` + `superseded_at = nowIso` on
   the rest.

Queries that should ignore reprocessing duplicates filter
`WHERE superseded_by IS NULL` (the bundled cookbook does this on every
recipe). The embed pass automatically skips superseded rows — we don't
waste Ollama calls on duplicates.

Hashing is incremental: a row's `audio_hash` is computed once on first
ingest and never re-computed (audio files are immutable once Super
Whisper writes them).

## sqlite-vec packaging

`sqlite-vec` is a SQLite loadable extension. It needs a vanilla SQLite build
(Apple's stripped-down build has loadable extensions disabled), which is why
the formula depends on `sqlite`.

We embed both `vec0-darwin-arm64.dylib` and `vec0-darwin-x64.dylib` into the
compiled `swrag` binary via `with { type: "file" }` import attributes. At
runtime `vec-loader.ts` writes the matching one to
`${tmpdir}/swrag-vec0-${user}/` so the system `dlopen()` can read it (the
system loader cannot read bunfs paths). The extracted file is cached by
content size so the next CLI invocation skips the write.

## Validation strategy

Every external value goes through a zod schema in `src/schemas.ts`:

- Environment variables → `EnvSchema`.
- CLI args → there are none beyond positionals (the CLI is zero-flag).
- Super Whisper DB rows → `SourceRecordingSchema`.
- `meta.json` → `MetaJsonSchema` (loose; preserves unknown fields).
- Ollama responses → `OllamaEmbedResponseSchema`, `OllamaTagsResponseSchema`.

There are zero `as`-casts on `unknown` data anywhere in the repo, and zero
unverified `prepare<Row, Params>` generics. Tests use `queryOne`/`queryAll`
helpers that schema-parse every result.

## Where the tool writes

- `~/Library/Application Support/superwhisper-rag/swrag.sqlite`
- `~/Library/Application Support/superwhisper-rag/meeting.sock` (only while `meeting watch` is running)
- `~/Library/Application Support/superwhisper-rag/meetings/incoming/*.wav` (queue audio)
- `~/Library/Logs/superwhisper-rag.log` (only when the meeting watcher is on)
- `~/Library/LaunchAgents/com.superwhisper-rag.meeting-watch.plist` (only when `meeting enable-watcher` is run)
- `~/Library/LaunchAgents/com.superwhisper-rag.meeting-menubar.plist` (only when `meeting enable-watcher` is run)
- `~/.cursor/skills/superwhisper-rag/SKILL.md` (only when `install-skill` is run)
- `~/.claude/skills/superwhisper-rag/SKILL.md` (only when `install-skill` is run)
- `/tmp/swrag-snap-*.sqlite` (deleted on success)
- `/tmp/swrag-vec0-<user>/vec0-<arch>-<size>.dylib` (cached)

Never inside `~/Library/Application Support/superwhisper/` or
`~/Documents/superwhisper/`.

## Why machine-level skills, not AGENTS.md

[AGENTS.md](https://agents.md) is project-scoped and always-on: any agent
working in a directory with an `AGENTS.md` reads it into its system prompt
every time. For a personal dictation archive that's the wrong default — we
want the schema + cookbook loaded only when the user explicitly asks for
it.

Cursor's and Claude Code's machine-level Skills systems give us exactly
that: install once into `~/.cursor/skills/<name>/SKILL.md` (and the Claude
equivalent), and the agent only sees the file when the user explicitly
invokes the skill. Our frontmatter sets
[`disable-model-invocation: true`](https://docs.anthropic.com/en/docs/claude-code/skills#restrict-claudes-skill-access)
— Anthropic's runtime-enforced opt-out that hides the skill (including
its description) from the agent's context entirely. The user invokes
the skill explicitly with `/superwhisper-rag` (Claude Code) or
`@superwhisper-rag` (Cursor); the agent has no signal to reach for it
on its own.
