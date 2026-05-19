import { defineCommand, runMain } from "citty";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "./config.ts";
import { error } from "./log.ts";
import { resolvePaths } from "./paths.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runEmbed } from "./commands/embed.ts";
import { disableSync, enableSync } from "./commands/enable-sync.ts";
import { runIndex } from "./commands/index.ts";
import { installSkill } from "./commands/install-skill.ts";
import { getPath, PathTargetSchema } from "./commands/path.ts";
import { runSql, readSqlInput } from "./commands/sql.ts";
import { EnvSchema } from "./schemas.ts";

/* -------------------------------------------------------------------------- */
/* Environment-driven configuration                                           */
/* -------------------------------------------------------------------------- */
/*                                                                            */
/* The CLI surface is intentionally tiny — two flags total. Anything that     */
/* used to be a flag is now an env var, parsed once via `EnvSchema`.          */
/*                                                                            */
/*   SWRAG_SOURCE_DIR     where Super Whisper's recordings live               */
/*   SWRAG_SOURCE_DB      Super Whisper's SQLite path                         */
/*   SWRAG_ARCHIVE        our archive's SQLite path                           */
/*   SWRAG_OLLAMA_HOST    Ollama base URL (or OLLAMA_HOST)                    */
/*   SWRAG_EMBED_MODEL    embedding model name                                */
/*   SWRAG_KEEP_ALIVE     Ollama keep_alive value (e.g. "0", "30s", "5m")     */
/*   SWRAG_SQLITE_DYLIB   custom path to libsqlite3.dylib                     */
/*   SWRAG_VERBOSE        any truthy value enables stderr verbose logs        */
/*   SWRAG_SKIP_EMBED     any truthy value skips the embed pass on ingest     */
/*                                                                            */
/* All have sensible defaults; you should never need to set any of them.      */
/* -------------------------------------------------------------------------- */

const env = EnvSchema.parse(Bun.env);

const paths = resolvePaths({
  sourceDir: env.SWRAG_SOURCE_DIR,
  sourceDb: env.SWRAG_SOURCE_DB,
  archive: env.SWRAG_ARCHIVE,
  ollamaHost: env.SWRAG_OLLAMA_HOST ?? env.OLLAMA_HOST,
  embedModel: env.SWRAG_EMBED_MODEL,
});

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
      "Run SQL through sqlite3 (vec preloaded, archive read-only, ingest first). Omit positional to enter REPL.",
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
    const sql = await readSqlInput(inline, fromStdin);
    const r = await runSql({
      sql,
      archive: paths.archive,
      sourceDb: paths.sourceDb,
      sourceDir: paths.sourceDir,
      embedModel: paths.embedModel,
      ollamaHost: paths.ollamaHost,
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
    await runIndex({
      ...paths,
      full: false,
      dryRun: false,
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
    const r = await runDoctor(paths);
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
    process.stdout.write(`${getPath({ target, archive: paths.archive })}\n`);
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
  run({ args }) {
    const text = asString(args.text);
    if (!text) throw new Error("missing required positional: text");
    process.stdout.write(
      runEmbed({
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
    description:
      "Install the manual-invocation SKILL.md to ~/.cursor and ~/.claude",
  },
  args: {},
  async run() {
    const results = await installSkill();
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

function resolveBinPath(): string {
  const execPath = process.execPath;
  if (execPath && !execPath.endsWith("/bun")) {
    try {
      return realpathSync(execPath);
    } catch {
      return execPath;
    }
  }
  return join("/opt/homebrew/bin", "swrag");
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
