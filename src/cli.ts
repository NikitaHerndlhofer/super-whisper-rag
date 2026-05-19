import { defineCommand, runMain } from "citty";
import { existsSync, realpathSync } from "node:fs";
import { VERSION } from "./config.ts";
import { getEnv } from "./env.ts";
import { error } from "./log.ts";
import { resolvePaths, type ResolvedPaths } from "./paths.ts";
import type { Env } from "./schemas.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runEmbed } from "./commands/embed.ts";
import { disableSync, enableSync } from "./commands/enable-sync.ts";
import { runIndex } from "./commands/index.ts";
import { installSkill } from "./commands/install-skill.ts";
import { getPath, PathTargetSchema } from "./commands/path.ts";
import { runSql, readSqlInput } from "./commands/sql.ts";

// The CLI surface is intentionally tiny — zero flags. Everything that used
// to be a flag is an env var, parsed and validated through `getEnv()`.
// See `src/schemas.ts` for the full list of `SWRAG_*` vars, and the
// README's "Configuration" table for the user-facing summary.
//
// We defer the actual `getEnv()` / `resolvePaths()` call until a handler
// runs (rather than evaluating at module top level) so that
// `swrag --help` and `swrag --version` work even when the user has a
// malformed env var set — citty handles help-only invocations without
// dispatching to a subcommand handler.
interface Context {
  env: Env;
  paths: ResolvedPaths;
}

let _ctx: Context | null = null;
function ctx(): Context {
  if (_ctx) return _ctx;
  const env = getEnv();
  const paths = resolvePaths({
    sourceDir: env.SWRAG_SOURCE_DIR,
    sourceDb: env.SWRAG_SOURCE_DB,
    archive: env.SWRAG_ARCHIVE,
    ollamaHost: env.SWRAG_OLLAMA_HOST ?? env.OLLAMA_HOST,
    embedModel: env.SWRAG_EMBED_MODEL,
  });
  _ctx = { env, paths };
  return _ctx;
}

/**
 * Everything after a literal `--` on the command line. We detect this
 * here, before citty runs, because citty's positional parser doesn't
 * preserve the `--` boundary for us. Capturing it once at entry keeps
 * the handler code from reaching back into `process.argv`.
 */
const DASHDASH_INDEX = process.argv.indexOf("--");
const PASSTHROUGH_ARGS: readonly string[] =
  DASHDASH_INDEX < 0 ? [] : process.argv.slice(DASHDASH_INDEX + 1);

/**
 * True iff the user typed a positional argument BEFORE the `--`
 * separator. Citty's parser doesn't respect `--`, so its `args.query`
 * value will include positionals that appear after `--` as well — we
 * can't use it to tell "the user supplied inline SQL alongside
 * passthrough" from "the user supplied SQL inside the passthrough".
 * For the conflict-detection in `sqlCmd`, we have to scan argv
 * ourselves and check whether anything non-flag lives between the
 * subcommand and the `--`.
 *
 * `subcommand` is the literal we expect at `process.argv[2]`, e.g.
 * `"sql"`. The function returns true if there's a positional in
 * `process.argv[3..DASHDASH_INDEX)` — strict bounds, because argv[2]
 * is the subcommand name itself and DASHDASH_INDEX is the `--`.
 */
function hasInlinePositionalBeforeDashDash(subcommand: string): boolean {
  if (DASHDASH_INDEX < 0) return false;
  // process.argv layout under bun-compiled CLI: [bun_exec, subcommand, ...]
  // and DASHDASH_INDEX is the index of `--`. We look at the args
  // strictly between (subcommand_idx + 1) and DASHDASH_INDEX.
  const subIdx = process.argv.indexOf(subcommand);
  if (subIdx < 0 || subIdx >= DASHDASH_INDEX - 1) return false;
  for (let i = subIdx + 1; i < DASHDASH_INDEX; i++) {
    const a = process.argv[i];
    if (a == null) continue;
    // Treat anything that doesn't start with `-` as a positional. (The
    // sql subcommand exposes zero flags of its own, so any `-…` token
    // before `--` is the user's mistake — but it's not "inline SQL".)
    if (!a.startsWith("-")) return true;
  }
  return false;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/* -------------------------------------------------------------------------- */
/* sql — thin proxy to the sqlite3 CLI                                        */
/* -------------------------------------------------------------------------- */

const sqlCmd = defineCommand({
  meta: {
    name: "sql",
    description:
      "Run SQL through sqlite3 (vec preloaded, archive read-only, ingest first). Omit positional to enter REPL. Use `--` to forward sqlite3 flags.",
  },
  args: {
    query: {
      type: "positional",
      required: false,
      description: "SQL string, '-' for stdin, or omit for the sqlite3 REPL",
    },
  },
  async run({ args }) {
    const queryArg = asString(args.query);
    const fromStdin = queryArg === "-";
    const inline = fromStdin ? null : (queryArg ?? null);
    // Reject `swrag sql "SQL" -- <args>`. Either form is fine on its own
    // — inline SQL, or SQL forwarded inside the `--` tail — but combining
    // them used to silently drop the inline SQL. Surface the conflict
    // rather than guess which one the user wanted.
    //
    // Note: we cannot rely on citty's `args.query` to tell us whether
    // the user supplied an inline positional, because citty doesn't
    // respect `--` and will happily pull a string out of the
    // passthrough tail and into `query`. We scan argv directly instead
    // — see `hasInlinePositionalBeforeDashDash`.
    if (PASSTHROUGH_ARGS.length > 0 && hasInlinePositionalBeforeDashDash("sql")) {
      error(
        "cannot combine inline SQL (or stdin) with `--` passthrough. " +
          "Put your SQL either before `--`, or inside the tail after `--` — not both.",
      );
      process.exit(2);
    }
    const sql = PASSTHROUGH_ARGS.length > 0 ? null : await readSqlInput(inline, fromStdin);
    const { paths } = ctx();
    const r = await runSql({
      sql,
      archive: paths.archive,
      sourceDb: paths.sourceDb,
      sourceDir: paths.sourceDir,
      embedModel: paths.embedModel,
      ollamaHost: paths.ollamaHost,
      extraArgs: [...PASSTHROUGH_ARGS],
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* index — Super Whisper ingestion                                            */
/* -------------------------------------------------------------------------- */

const indexCmd = defineCommand({
  meta: {
    name: "index",
    description: "Ingest changes from Super Whisper into the archive",
  },
  args: {},
  async run() {
    const { env, paths } = ctx();
    await runIndex({
      ...paths,
      skipEmbeddings: env.SWRAG_SKIP_EMBED,
    });
  },
});

/* -------------------------------------------------------------------------- */
/* doctor                                                                     */
/* -------------------------------------------------------------------------- */

const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "Verify your setup" },
  args: {},
  async run() {
    const r = await runDoctor(ctx().paths);
    process.stdout.write(r.output);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* path — print a filesystem path                                             */
/* -------------------------------------------------------------------------- */

const pathCmd = defineCommand({
  meta: {
    name: "path",
    description: "Print a path: archive (default), sqlite3, or vec0",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "archive | sqlite3 | vec0",
    },
  },
  run({ args }) {
    const target = PathTargetSchema.parse(asString(args.target) ?? "archive");
    process.stdout.write(`${getPath({ target, archive: ctx().paths.archive })}\n`);
  },
});

/* -------------------------------------------------------------------------- */
/* embed — print a vector as a SQL blob literal                               */
/* -------------------------------------------------------------------------- */

const embedCmd = defineCommand({
  meta: {
    name: "embed",
    description: "Emit a SQL blob literal (x'…') of the given text's embedding",
  },
  args: {
    text: { type: "positional", required: true, description: "Text to embed" },
  },
  async run({ args }) {
    const text = asString(args.text);
    if (!text) throw new Error("missing required positional: text");
    const { paths } = ctx();
    process.stdout.write(
      await runEmbed({
        text,
        embedModel: paths.embedModel,
        ollamaHost: paths.ollamaHost,
      }),
    );
  },
});

/* -------------------------------------------------------------------------- */
/* install-skill / enable-sync / disable-sync                                 */
/* -------------------------------------------------------------------------- */

const installSkillCmd = defineCommand({
  meta: {
    name: "install-skill",
    description: "Install the manual-invocation SKILL.md to ~/.cursor and ~/.claude",
  },
  args: {},
  async run() {
    const results = await installSkill(ctx().paths.archive);
    for (const r of results) {
      process.stdout.write(`${r.action}: ${r.path}\n`);
    }
  },
});

const enableSyncCmd = defineCommand({
  meta: {
    name: "enable-sync",
    description: "Install hourly launchd sync agent",
  },
  args: {},
  async run() {
    await enableSync({ binPath: resolveBinPath() });
  },
});

const disableSyncCmd = defineCommand({
  meta: { name: "disable-sync", description: "Remove the launchd sync agent" },
  args: {},
  async run() {
    await disableSync();
  },
});

/**
 * Resolve the binary path that the launchd plist should embed.
 *
 * We deliberately prefer Homebrew's stable symlink (`/opt/homebrew/bin/swrag`)
 * over the version-specific Cellar realpath. On `brew upgrade superwhisper-rag`
 * the new bottle lands at a fresh Cellar dir, the symlink is rewired
 * atomically, and `brew cleanup` deletes the old Cellar — which would
 * leave a launchd plist pointing at a deleted realpath. The symlink
 * survives upgrades, so the plist captured by `swrag enable-sync` keeps
 * working across versions without re-running the command.
 *
 * Resolution order:
 *   1. /opt/homebrew/bin/swrag                    (Apple Silicon brew)
 *   2. /usr/local/bin/swrag                       (Intel brew)
 *   3. realpath(process.execPath)                 (compiled binary outside brew)
 *
 * If none of those resolve we throw rather than write a plist that
 * points at a path which is known not to exist — the user would only
 * discover the breakage when launchd silently failed to fire the
 * hourly sync.
 */
function resolveBinPath(): string {
  for (const p of ["/opt/homebrew/bin/swrag", "/usr/local/bin/swrag"]) {
    if (existsSync(p)) return p;
  }
  const execPath = process.execPath;
  if (execPath && !execPath.endsWith("/bun")) {
    try {
      return realpathSync(execPath);
    } catch {
      return execPath;
    }
  }
  throw new Error(
    "cannot resolve a stable swrag binary path for launchd. " +
      "Install via Homebrew (`brew install NikitaHerndlhofer/tap/superwhisper-rag`) " +
      "and re-run `swrag enable-sync`.",
  );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const main = defineCommand({
  meta: {
    name: "swrag",
    version: VERSION,
    description:
      "Thin sqlite3 wrapper for your Super Whisper dictation archive. Adds a sync ingester and an embed() shortcut.",
  },
  subCommands: {
    sql: sqlCmd,
    index: indexCmd,
    doctor: doctorCmd,
    path: pathCmd,
    embed: embedCmd,
    "install-skill": installSkillCmd,
    "enable-sync": enableSyncCmd,
    "disable-sync": disableSyncCmd,
  },
});

runMain(main).catch((e: unknown) => {
  error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
