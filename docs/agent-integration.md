# Agent integration

`swrag` ships a `SKILL.md` for Cursor and Claude Code's machine-level
Skills systems. Installation is one command:

```bash
swrag install-skill
```

This writes **both**:

- `~/.cursor/skills/superwhisper-rag/SKILL.md`
- `~/.claude/skills/superwhisper-rag/SKILL.md`

There is no `--target` flag. Writing to both unconditionally is harmless
— a runtime that isn't installed simply never reads the file, and the
file itself is <10 KB. The command is idempotent and backs up any
existing `SKILL.md` whose content differs as `SKILL.md.bak.<timestamp>`.

## Manual invocation only

The bundled `SKILL.md` uses the
[`disable-model-invocation`](https://docs.anthropic.com/en/docs/claude-code/skills#restrict-claudes-skill-access)
frontmatter field — Anthropic's officially-supported opt-out from
autonomous skill routing:

```yaml
---
name: superwhisper-rag
description: Query the user's local Super Whisper dictation archive (SQLite + bge-m3 embeddings). Manual invocation only.
disable-model-invocation: true
---
```

Per Anthropic's docs, with `disable-model-invocation: true`:

| You can invoke | Claude can invoke | When loaded into context                                              |
| -------------- | ----------------- | --------------------------------------------------------------------- |
| Yes            | **No**            | **Description not in context, full skill loads only when you invoke** |

In other words: **even the skill's description is hidden from the
agent's context.** The agent has no mechanism — no signal, no name in a
list, no description to match against — for reaching for the skill on
its own. Only the user can summon it:

- **Claude Code**: `/superwhisper-rag` (or browse via `/skills`)
- **Cursor**: `@superwhisper-rag`

When invoked, the agent gets the full schema + cookbook + `embed()`
contract in its context and knows how to query the archive for the rest
of that conversation.

If you ever want the agent to auto-route — say you want it to reach for
the skill when you talk about dictations — delete the
`disable-model-invocation` line (and optionally tighten the
`description` to describe the trigger conditions). The two changes
together flip the contract back to the default behaviour. We ship with
the strict opt-out on purpose; that was the explicit ask.

## Why not AGENTS.md

[AGENTS.md](https://agents.md) is also a reasonable target — but it's
**project-level and always-on**. Any agent working in a directory that
contains an `AGENTS.md` reads it into its system prompt, every time. That
inverts what you want: the archive is personal, not project-scoped, and
should be loaded on demand, not by default. So we install a machine-level
skill instead.

## What the skill teaches

- The full archive schema (`recording`, `recording_fts`, `recording_vec`, `v_search`).
- The zero-flag CLI surface: `swrag sql "<sql>"` and nothing else.
- The semantic-search pattern: `$(swrag embed 'text')` shell composition
  produces a `x'…'` blob literal that you paste directly into your SQL.
- The hybrid (RRF) pattern for FTS + vector search.
- The shell-composition escape hatch: `sqlite3 "$(swrag path)" -cmd
".load $(swrag path vec0) sqlite3_vec_init" "<sql>"` for any feature
  sqlite3 has that we don't expose (output modes, dot-commands, named
  parameters, etc.).

## Output contract

`swrag sql` always produces sqlite3's default `list` mode output:
pipe-separated, no header. For agent consumption you have two options:

1. **Use sqlite3's JSON via shell composition** — works in any agent:

   ```bash
   sqlite3 "$(swrag path)" \
     -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
     -cmd ".mode json" \
     "<your sql>"
   ```

2. **Parse list mode** — pipe-separated, lossy if your data contains
   pipes. Fine for many cases.

Any other sqlite3 output mode (csv, column, line, box, markdown, …) is
available via the same `swrag path` + `sqlite3 -cmd ".mode <fmt>"`
pattern.

## Ingestion is automatic

Every `swrag sql` runs a sub-millisecond mtime-fast-path ingest before
the query — fresh dictations are visible immediately and you never have
to think about syncing.

## Privacy in agent contexts

`meta.json` contains the LLM prompt, clipboard nouns, and application
state at the time of recording. The skill instructs the agent **not** to
surface prompt or clipboard data unless the user explicitly asks.

## Recipes that work well as prompts

(After invoking the skill.)

- "What did I dictate this morning?" → cookbook recipe 1.
- "Find meetings about BullMQ from last week." → recipes 2 + 3.
- "Where did I talk about notifications going to the right user?" → recipe 4 with `embed(:q)`.
- "Show me everything I dictated while in Cursor in Portuguese." → `WHERE app_name = 'Cursor' AND language = 'pt'`.
- "How much have I talked this week?" → recipe 7.
- "What's still in the archive that Super Whisper deleted?" → recipe 10.
