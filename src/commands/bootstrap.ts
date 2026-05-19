/**
 * One-shot, idempotent finisher for `brew install`. Brings the entire
 * application from "binary on disk" to "ready to use, syncing in the
 * background, agent-searchable" — in a single command.
 *
 * `brew install superwhisper-rag` puts the binary on disk and pulls
 * ollama as a hard dependency. Everything else lives here, in this
 * order:
 *
 *   1. Ollama service — start it via `brew services start ollama` if
 *      not already reachable, then poll briefly until it accepts
 *      requests.
 *   2. Embed model — `ollama pull <model>` (one-time ~2 GB) if not
 *      already present, with the live progress UI inherited so the
 *      user sees what's happening.
 *   3. Archive — run an initial `swrag index` to populate the SQLite
 *      database from Super Whisper's data (transcripts, embeddings,
 *      supersedence detection).
 *   4. Background sync — install the launchd agent so the archive
 *      stays in sync hourly without manual `swrag index` calls.
 *   5. Agent skill — write the manual-invocation SKILL.md to
 *      ~/.cursor/skills/superwhisper-rag/ and ~/.claude/skills/.
 *      Harmless if those tools aren't installed (the file just sits
 *      dormant).
 *   6. Final verify — run `swrag doctor`.
 *
 * Safe to re-run. Each step is a check-and-fix:
 *   - Ollama: skipped if reachable.
 *   - Model pull: skipped if `bge-m3` already present.
 *   - Ingest: mtime fast-path makes it sub-millisecond when nothing
 *     in Super Whisper has changed.
 *   - launchd: bootouts the running instance first, idempotent.
 *   - Skill: only overwrites when content matches the last hash we
 *     wrote — user edits are preserved.
 *
 * `swrag bootstrap` doubles as a "reset to known good state" command
 * because of the above.
 */
import { existsSync, realpathSync } from "node:fs";
import { checkOllama } from "../embed/ollama.ts";
import { ensureFresh } from "../ingest/ingester.ts";
import { installLaunchAgent } from "../launchd/install.ts";
import { info, verbose } from "../log.ts";
import { runDoctor } from "./doctor.ts";
import { installSkill } from "./install-skill.ts";

const SERVICE_START_WAIT_MS = 8_000;
const SERVICE_START_POLL_INTERVAL_MS = 500;

export interface BootstrapOptions {
  ollamaHost: string;
  embedModel: string;
  archive: string;
  sourceDb: string;
  sourceDir: string;
  /** Override `brew services start ollama` for tests. */
  startOllama?: () => Promise<void>;
  /** Override `ollama pull <model>` for tests. */
  pullModel?: (model: string) => Promise<void>;
  /** Override `doctor` for tests. */
  doctor?: () => Promise<{ exitCode: number; output: string }>;
  /** Override the readiness poll for tests. */
  isOllamaReachable?: () => Promise<boolean>;
  /**
   * Override the model-presence check for tests. Returns null when the
   * model is present, a "not pulled" string to trigger a pull, or any
   * other string to surface as a fatal bootstrap error. Matches
   * `checkOllama`'s contract.
   */
  checkOllamaModel?: (host: string, model: string) => Promise<string | null>;
  /** Override the post-service-start wait budget for tests. */
  serviceStartWaitMs?: number;
  /** Override the initial archive ingest for tests. */
  ingest?: () => Promise<void>;
  /** Override the launchd sync installer for tests. */
  installSync?: () => Promise<void>;
  /** Override the agent skill installer for tests. */
  installAgentSkill?: () => Promise<void>;
  /**
   * Skip the launchd sync install. Useful in dev (running via
   * `bun run`) where the binary isn't yet at a stable Homebrew path
   * and `installLaunchAgent` would have nothing sensible to embed.
   */
  skipSync?: boolean;
  /** Skip the agent skill install. */
  skipSkill?: boolean;
}

export interface BootstrapResult {
  exitCode: number;
  startedOllama: boolean;
  pulledModel: boolean;
  ingested: boolean;
  installedSync: boolean;
  installedSkill: boolean;
  doctorOutput: string;
}

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const host = opts.ollamaHost;
  const model = opts.embedModel;
  const waitBudget = opts.serviceStartWaitMs ?? SERVICE_START_WAIT_MS;
  let startedOllama = false;
  let pulledModel = false;
  let ingested = false;
  let installedSync = false;
  let installedSkill = false;

  const reachable = opts.isOllamaReachable ?? (() => isOllamaReachable(host));
  const startOllama = opts.startOllama ?? (() => brewServicesStartOllama());
  const pullModel = opts.pullModel ?? ((m: string) => ollamaPull(host, m));
  const checkModel =
    opts.checkOllamaModel ?? ((h: string, m: string) => checkOllama({ host: h, model: m }));
  const ingestFn =
    opts.ingest ??
    (async () => {
      await ensureFresh({
        sourceDb: opts.sourceDb,
        sourceDir: opts.sourceDir,
        archive: opts.archive,
        embedModel: model,
        ollamaHost: host,
      });
    });
  const installSyncFn =
    opts.installSync ??
    (async () => {
      await installLaunchAgent({ binPath: resolveStableBinPath() });
    });
  const installSkillFn =
    opts.installAgentSkill ??
    (async () => {
      await installSkill(opts.archive);
    });

  // 1. Ollama service
  info(`bootstrap: checking ollama at ${host}`);
  if (!(await reachable())) {
    info("bootstrap: ollama not reachable; starting via `brew services start ollama`");
    await startOllama();
    if (!(await waitForReachability(reachable, waitBudget))) {
      throw new Error(
        `ollama did not become reachable at ${host} within ${waitBudget}ms. ` +
          "Try `brew services start ollama` manually and re-run `swrag bootstrap`.",
      );
    }
    startedOllama = true;
    info("bootstrap: ollama is up");
  } else {
    verbose("bootstrap: ollama already reachable");
  }

  // 2. Embed model
  info(`bootstrap: checking embed model "${model}"`);
  const modelStatus = await checkModel(host, model);
  if (modelStatus?.includes("not pulled")) {
    info(`bootstrap: pulling ${model} (this is a one-time ~2 GB download)`);
    await pullModel(model);
    pulledModel = true;
  } else if (modelStatus != null) {
    throw new Error(`ollama check failed: ${modelStatus}`);
  } else {
    verbose(`bootstrap: ${model} already pulled`);
  }

  // 3. Archive ingest
  info("bootstrap: indexing the archive (sub-ms fast-path if Super Whisper hasn't changed)");
  await ingestFn();
  ingested = true;

  // 4. launchd background sync
  if (opts.skipSync) {
    verbose("bootstrap: skipping launchd sync (--skip-sync)");
  } else {
    info("bootstrap: installing hourly background sync (launchd)");
    try {
      await installSyncFn();
      installedSync = true;
    } catch (e) {
      // Most common failure: running from a `bun run` dev context
      // where there's no stable binary path. Surface the error but
      // don't abort — the rest of the bootstrap should still
      // complete.
      info(
        `bootstrap: launchd sync install skipped (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  // 5. Agent skill
  if (opts.skipSkill) {
    verbose("bootstrap: skipping agent skill install (--skip-skill)");
  } else {
    info("bootstrap: installing manual-invocation agent skill for Cursor + Claude Code");
    await installSkillFn();
    installedSkill = true;
  }

  // 6. Doctor — final verify
  const doctor =
    opts.doctor ??
    (() =>
      runDoctor({
        ollamaHost: host,
        embedModel: model,
        archive: opts.archive,
        sourceDb: opts.sourceDb,
      }));
  const r = await doctor();
  process.stdout.write(r.output);

  // Quick human-readable summary so the user sees what happened.
  const summary: string[] = [];
  summary.push(startedOllama ? "started ollama" : "ollama already up");
  summary.push(pulledModel ? `pulled ${model}` : `${model} already pulled`);
  summary.push(ingested ? "archive indexed" : "archive skipped");
  summary.push(installedSync ? "hourly sync enabled" : "sync skipped");
  summary.push(installedSkill ? "agent skill installed" : "skill skipped");
  info(`bootstrap done: ${summary.join("; ")}`);

  return {
    exitCode: r.exitCode,
    startedOllama,
    pulledModel,
    ingested,
    installedSync,
    installedSkill,
    doctorOutput: r.output,
  };
}

/**
 * Resolve the stable Homebrew symlink path for the swrag binary, the
 * same way `cli.ts::resolveBinPath` does for `swrag enable-sync`.
 * Duplicated here intentionally — the CLI's version reaches into
 * `process.execPath` which we don't want bootstrap (a library
 * function) to depend on.
 */
function resolveStableBinPath(): string {
  for (const p of ["/opt/homebrew/bin/swrag", "/usr/local/bin/swrag"]) {
    if (existsSync(p)) return p;
  }
  // Fall back to the current process's binary if it's a real file (a
  // compiled binary outside Homebrew). Reject if we're under `bun`
  // itself — that path won't exist after the bun build session ends.
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
      "and re-run `swrag bootstrap`.",
  );
}

async function isOllamaReachable(host: string): Promise<boolean> {
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForReachability(
  reachable: () => Promise<boolean>,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await reachable()) return true;
    await sleep(SERVICE_START_POLL_INTERVAL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Run `brew services start ollama`. We don't inherit stdio because
 * `brew services` is chatty and adds noise; the user only cares
 * whether it succeeded, which we verify by polling reachability.
 */
async function brewServicesStartOllama(): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["brew", "services", "start", "ollama"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `\`brew services start ollama\` failed (exit ${exitCode}): ${stderr.trim() || "(no stderr)"}`,
    );
  }
}

/**
 * Run `ollama pull <model>` with stdio inherited so the user sees the
 * download progress bar. We talk directly to the `ollama` binary
 * rather than the HTTP API for two reasons: (1) the binary's progress
 * UI is much nicer than the raw NDJSON the API streams, and (2) it
 * matches what the user would type by hand if our bootstrap didn't
 * exist.
 *
 * `host` is currently unused but accepted for future override of
 * `OLLAMA_HOST` when we want to support non-default hosts. The binary
 * honours that env var natively.
 */
async function ollamaPull(host: string, model: string): Promise<void> {
  const env = { ...process.env, OLLAMA_HOST: host };
  const proc = Bun.spawn({
    cmd: ["ollama", "pull", model],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`\`ollama pull ${model}\` failed with exit ${exitCode}`);
  }
}
