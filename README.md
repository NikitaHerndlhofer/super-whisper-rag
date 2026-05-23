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
3. Warms the macOS permissions the meeting watcher needs (microphone,
   screen recording, Apple Events per browser). macOS surfaces a
   dialog for each not-yet-decided permission — say yes to each one.
4. Installs the meeting watcher (a launchd KeepAlive daemon plus the
   menu bar).
5. Indexes your Super Whisper archive (applies schema migrations,
   chunks any long-form recordings; see above).
6. Installs the manual-invocation agent skill for Cursor and Claude Code.
7. Runs `swrag doctor` and prints a summary.

Idempotent — re-run any time to restore the setup to known-good state.
Each step is independently invokable too (`swrag index`,
`swrag meeting enable-watcher`, `swrag meeting permissions-check
--prompt`, `swrag install-skill`, `swrag doctor`) if you'd rather
pick and choose.

### About the meeting watcher

`swrag bootstrap` installs the meeting watcher: two `KeepAlive`
launchd agents that keep two processes alive in the background.

- `swrag meeting watch` — the daemon. Detects meetings event-driven
  (NSWorkspace + CoreAudio notifications via a vendored Swift helper,
  no polling), offers to start a recording when one begins, and
  drives the FIFO meeting queue when you click `▶ Start queue
  processing` in the menu bar. After a recording finishes,
  Super Whisper transcribes it and the daemon targeted-ingests the
  result into the swrag archive immediately.
- `swrag meeting menubar` — the menu bar status item. Subscribes to
  the daemon's unix socket over line-delimited JSON and renders the
  current state. From it you can start/stop a recording, start/pause
  queue processing, and discard or show items in Finder.

Manage them with `swrag meeting enable-watcher` / `swrag meeting
disable-watcher`. The bootstrap step is just a thin wrapper around
`enable-watcher`.

Prior versions of swrag installed an hourly `swrag index` launchd
cron. That cron is gone — the watcher's processor calls a targeted
ingest after every recording completes, and every `swrag sql` runs a
sub-millisecond `ensureFresh()` mtime fast-path ingest before the
query. Live Super Whisper dictations (made outside the watcher) land
in the archive on first query — the first such query after a new
dictation pays a one-time ~5–30 s embed pass; subsequent queries are
fast.

#### Mode is the user's responsibility

The user sets Super Whisper's mode (Universal, Meeting, etc.) via
Super Whisper's own UI **before** clicking `▶ Start queue
processing`. The watcher does **not** touch Super Whisper's mode.

- All items in a single Start → Pause cycle are transcribed in the
  same mode. If you want different items in different modes, pause
  between them, switch Super Whisper mode manually, then start again.
  Pause's "finish current item, don't start next" semantics make this
  clean.
- After processing finishes, Super Whisper is still in whatever mode
  you set. If you intend to dictate normally afterward, switch back
  yourself.
- We deliberately don't automate mode swapping. The space-character
  bug in Super Whisper's mode-switch URL scheme is therefore not on
  swrag's critical path.

#### System audio recording — legal note

swrag does **not** enable system audio capture by default. When you
enable it (via `swrag meeting enable-watcher --system-audio` or
`swrag meeting record start --system-audio`), the recorder captures
audio output from all applications, including the other party's voice
in calls.

You are solely responsible for complying with local recording laws:
two-party-consent jurisdictions (most of the EU, several US states,
elsewhere), GDPR, and any company policies that apply to your calls.
swrag does **not** notify other call participants — that's on you.

The first time you enable system audio, you'll be asked to pass
`--ack-legal` to acknowledge the warning. The acknowledgement is
persisted in the archive's `config` table so subsequent invocations
don't re-prompt.

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

Reports the health of every piece swrag depends on: extension-capable
sqlite3 + vec extension + Ollama + archive + data version + chunk
coverage + meeting watcher (launchd) + macOS permissions.

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

| Command                                            | What it does                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `swrag sql [SQL]`                                  | Run SQL via sqlite3 (default: list mode). Omit SQL to open the REPL. Pass `-` to read from stdin. |
| `swrag index`                                      | Ingest changes from Super Whisper now.                                                            |
| `swrag bootstrap`                                  | One-shot post-install: start ollama, pull `bge-m3`, warm permissions, install the meeting watcher, index, install the agent skill, verify. Safe to re-run. |
| `swrag doctor`                                     | Verify the environment.                                                                           |
| `swrag path [archive\|sqlite3\|vec0]`              | Print a filesystem path. Default: `archive`.                                                      |
| `swrag embed "TEXT"`                               | Print the embedding of `TEXT` as a SQLite blob literal (`x'…'`), for shell composition.           |
| `swrag install-skill`                              | Install the manual-invocation `SKILL.md` to Cursor and Claude Code.                               |
| `swrag enqueue <path.wav>`                         | Add a wav file to the meeting queue (for manual processing).                                      |
| `swrag meeting watch`                              | Run the meeting capture daemon in the foreground (used by launchd).                               |
| `swrag meeting menubar`                            | Run the menu bar status item (used by launchd).                                                   |
| `swrag meeting enable-watcher [--system-audio]`    | Install the meeting-watcher launchd agents (daemon + menu bar). `--system-audio` opts into capturing other apps' audio output. |
| `swrag meeting disable-watcher`                    | Remove the meeting-watcher launchd agents.                                                        |
| `swrag meeting status`                             | Probe current meeting state (frontmost app, mic in use, detection signal).                        |
| `swrag meeting permissions-check [--prompt]`       | Probe microphone / screen recording / Apple Events permissions. `--prompt` fires the macOS dialogs. |
| `swrag meeting record start [--system-audio]`      | Start a recording (foreground without the daemon, or via daemon if running).                      |
| `swrag meeting record stop [--discard]`            | Stop the daemon's current recording.                                                              |
| `swrag meeting queue list [--status …]`            | Print queue contents.                                                                             |
| `swrag meeting queue start`                        | Begin draining the queue.                                                                         |
| `swrag meeting queue pause`                        | Pause after the current item finishes.                                                            |
| `swrag meeting queue state`                        | Print the current queue state (one line).                                                         |
| `swrag meeting queue discard <id>`                 | Discard a queued row (deletes the wav).                                                           |

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
