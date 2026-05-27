/**
 * One-shot, idempotent finisher for `brew install`. Brings the entire
 * application from "binary on disk" to "ready to use, meeting watcher
 * running, agent-searchable" — in a single command.
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
 *   3. Permissions warm-up — `swrag-helper permissions-check --prompt`.
 *      Triggers the macOS permission dialogs for microphone, screen
 *      recording, and per-browser Automation / Apple Events. Required
 *      before the meeting watcher can run productively.
 *   4. Meeting watcher — `enableWatcher` installs the two keepalive
 *      launchd agents (`swrag meeting watch` daemon + `swrag meeting
 *      menubar`). Replaces the old hourly `swrag index` cron — the
 *      watcher's processor calls a targeted ingest after every
 *      recording, and `swrag sql` runs `ensureFresh()` on every query,
 *      so there's no separate hourly job needed.
 *   5. Archive — run an initial `swrag index` to populate the SQLite
 *      database from Super Whisper's data (transcripts, embeddings,
 *      supersedence detection).
 *   6. Agent skill — write the manual-invocation SKILL.md to
 *      ~/.cursor/skills/superwhisper-rag/ and ~/.claude/skills/.
 *      Harmless if those tools aren't installed (the file just sits
 *      dormant).
 *   7. Final verify — run `swrag doctor`.
 *
 * Safe to re-run. Each step is a check-and-fix:
 *   - Ollama: skipped if reachable.
 *   - Model pull: skipped if `bge-m3` already present.
 *   - Permissions: idempotent at the OS level — `--prompt` is a no-op
 *     for items that are already granted; only `not_determined` ones
 *     surface a dialog.
 *   - Watcher: `installLaunchAgent` bootouts the running instance
 *     first, so re-running `enable-watcher` rewires the plists
 *     cleanly.
 *   - Ingest: mtime fast-path makes it sub-millisecond when nothing
 *     in Super Whisper has changed.
 *   - Skill: only overwrites when content matches the last hash we
 *     wrote — user edits are preserved.
 *
 * `swrag bootstrap` doubles as a "reset to known good state" command
 * because of the above.
 */
import { existsSync, realpathSync } from "node:fs";
import { checkOllama } from "../embed/ollama.ts";
import { ensureFresh } from "../ingest/ingester.ts";
import { info, verbose, warn } from "../log.ts";
import { getPermissions, type Permissions } from "../mac/helper.ts";
import { enableWatcher, type EnableWatcherResult } from "./enable-watcher.ts";
import { runDoctor } from "./doctor.ts";
import { installSkill } from "./install-skill.ts";
import {
  currentHelperSignatureSummary,
  runSetupSigning,
  type SetupSigningResult,
} from "./setup-signing.ts";

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
  /** Override the permissions warm-up for tests. */
  warmPermissions?: () => Promise<Permissions>;
  /** Override the meeting-watcher install for tests. */
  installWatcher?: () => Promise<EnableWatcherResult>;
  /** Override the initial archive ingest for tests. */
  ingest?: () => Promise<void>;
  /** Override the agent skill installer for tests. */
  installAgentSkill?: () => Promise<void>;
  /**
   * Override the signing-prompt step for tests. Defaults to the
   * stdin-driven prompt described in the field doc on `skipSigning`.
   */
  promptForSigning?: () => Promise<boolean>;
  /**
   * Override the setup-signing run for tests. Defaults to invoking
   * `runSetupSigning` with the current archive.
   */
  runSetupSigning?: () => Promise<SetupSigningResult>;
  /**
   * Override the signature-state probe for tests. Returns the same
   * human-readable summary that `currentHelperSignatureSummary()`
   * would (`"ad-hoc"` / `"Apple Development: …"` / null when the
   * helper isn't materialised yet).
   */
  signatureSummary?: () => string | null;
  /**
   * Skip the macOS permission warm-up. Useful in CI where dialogs
   * aren't possible.
   */
  skipPermissions?: boolean;
  /**
   * Skip the meeting-watcher install. Useful in dev (running via
   * `bun run`) where the binary isn't yet at a stable Homebrew path
   * and `installLaunchAgent` would have nothing sensible to embed.
   */
  skipWatcher?: boolean;
  /** Skip the agent skill install. */
  skipSkill?: boolean;
  /**
   * Skip the signing-prompt step entirely. Bootstrap-time signing
   * has a UX side effect (`stdin` read for [y/N]) that we don't
   * want during non-interactive installs or test runs.
   * Also forced off when SWRAG_SKIP_SIGNING_PROMPT=1 in the
   * environment — that knob exists so CI / Homebrew automations can
   * suppress the prompt without changing the calling code.
   */
  skipSigning?: boolean;
}

export interface BootstrapResult {
  exitCode: number;
  startedOllama: boolean;
  pulledModel: boolean;
  warmedPermissions: boolean;
  installedWatcher: boolean;
  ingested: boolean;
  installedSkill: boolean;
  /** True iff `setup-signing` ran (and exit-0'd). */
  ranSetupSigning: boolean;
  doctorOutput: string;
}

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const host = opts.ollamaHost;
  const model = opts.embedModel;
  const waitBudget = opts.serviceStartWaitMs ?? SERVICE_START_WAIT_MS;
  let startedOllama = false;
  let pulledModel = false;
  let warmedPermissions = false;
  let installedWatcher = false;
  let ingested = false;
  let installedSkill = false;
  let ranSetupSigning = false;

  const reachable = opts.isOllamaReachable ?? (() => isOllamaReachable(host));
  const startOllama = opts.startOllama ?? (() => brewServicesStartOllama());
  const pullModel = opts.pullModel ?? ((m: string) => ollamaPull(host, m));
  const checkModel =
    opts.checkOllamaModel ?? ((h: string, m: string) => checkOllama({ host: h, model: m }));
  const warmPermissionsFn =
    opts.warmPermissions ?? (() => getPermissions({ prompt: true }));
  const installWatcherFn =
    opts.installWatcher ??
    (() =>
      enableWatcher({
        binPath: resolveStableBinPath(),
        archive: opts.archive,
      }));
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
  const installSkillFn =
    opts.installAgentSkill ??
    (async () => {
      await installSkill(opts.archive);
    });
  const signatureSummaryFn = opts.signatureSummary ?? currentHelperSignatureSummary;
  const promptSigningFn = opts.promptForSigning ?? defaultPromptForSigning;
  const runSetupSigningFn =
    opts.runSetupSigning ?? (() => runSetupSigning({ archive: opts.archive }));

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

  // 3. Permission warm-up
  if (opts.skipPermissions) {
    verbose("bootstrap: skipping permissions warm-up (--skip-permissions)");
  } else {
    info(
      "bootstrap: warming macOS permissions (mic + screen recording + Apple Events). " +
        "macOS will surface a dialog for each not-yet-decided permission — say yes to each one.",
    );
    try {
      const perms = await warmPermissionsFn();
      warmedPermissions = true;
      logPermissionsSummary(perms);
    } catch (e) {
      // The Swift helper might be missing on dev installs or might
      // hit an unexpected error path; don't abort the whole bootstrap.
      warn(
        `bootstrap: permissions warm-up failed (${e instanceof Error ? e.message : String(e)}). ` +
          "You can re-run via `swrag meeting permissions-check --prompt`.",
      );
    }
  }

  // 4. Meeting watcher (replaces the old hourly sync cron)
  if (opts.skipWatcher) {
    verbose("bootstrap: skipping meeting watcher install (--skip-watcher)");
  } else {
    info(
      "bootstrap: installing the meeting watcher (KeepAlive daemon + menu bar). " +
        "The watcher's processor calls a targeted `swrag index` after each recording, " +
        "so there's no separate hourly sync needed.",
    );
    try {
      const r = await installWatcherFn();
      installedWatcher = true;
      verbose(`bootstrap: meeting watcher installed: watch=${r.watchPlist}, menubar=${r.menubarPlist}`);
    } catch (e) {
      // Most common failure: running from a `bun run` dev context
      // where there's no stable binary path. Surface the error but
      // don't abort — the rest of the bootstrap should still
      // complete.
      info(
        `bootstrap: meeting watcher install skipped (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  // 5. Signing prompt — v0.9.12+. Asks the user whether they want to
  //    re-sign the helper bundle with their own free Apple Development
  //    cert, which is the only way to make ScreenCaptureKit attribution
  //    land reliably on macOS Sequoia/Tahoe. Default is "no" so
  //    mic-only users (who never need Screen Recording) don't pay the
  //    Xcode dependency.
  //
  //    Skipped when:
  //      - opts.skipSigning was passed (tests, non-interactive)
  //      - SWRAG_SKIP_SIGNING_PROMPT=1 in the environment (CI, scripted
  //        installs)
  //      - the helper bundle is already non-ad-hoc-signed (idempotent
  //        re-runs don't re-ask)
  if (opts.skipSigning || process.env.SWRAG_SKIP_SIGNING_PROMPT === "1") {
    verbose("bootstrap: skipping signing prompt (opts.skipSigning or SWRAG_SKIP_SIGNING_PROMPT)");
  } else {
    const summary = signatureSummaryFn();
    if (summary != null && summary !== "ad-hoc") {
      verbose(`bootstrap: helper already signed with ${summary}; skipping signing prompt`);
    } else {
      info(
        "bootstrap: helper is ad-hoc-signed. System audio recording on macOS Sequoia/Tahoe " +
          "requires re-signing with your own free Apple Development cert (mic-only works without it).",
      );
      let answer = false;
      try {
        answer = await promptSigningFn();
      } catch (e) {
        warn(
          `bootstrap: signing prompt failed (${e instanceof Error ? e.message : String(e)}); ` +
            "skipping. Re-run with `swrag setup-signing` later.",
        );
      }
      if (answer) {
        try {
          const r = await runSetupSigningFn();
          if (r.exitCode === 0 && r.outcome === "signed") {
            ranSetupSigning = true;
          } else {
            info(
              `bootstrap: setup-signing exited ${r.exitCode} (outcome=${r.outcome}). ` +
                "Re-run `swrag setup-signing` after the prerequisites are in place.",
            );
          }
        } catch (e) {
          warn(
            `bootstrap: setup-signing threw (${e instanceof Error ? e.message : String(e)}); ` +
              "continuing — re-run `swrag setup-signing` manually.",
          );
        }
      } else {
        info("bootstrap: skipped signing setup — run `swrag setup-signing` later if you want system-audio recording.");
      }
    }
  }

  // 6. Archive ingest
  info("bootstrap: indexing the archive (sub-ms fast-path if Super Whisper hasn't changed)");
  await ingestFn();
  ingested = true;

  // 7. Agent skill
  if (opts.skipSkill) {
    verbose("bootstrap: skipping agent skill install (--skip-skill)");
  } else {
    info("bootstrap: installing manual-invocation agent skill for Cursor + Claude Code");
    await installSkillFn();
    installedSkill = true;
  }

  // 8. Doctor — final verify
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
  summary.push(warmedPermissions ? "warmed permissions" : "permissions skipped");
  summary.push(installedWatcher ? "meeting watcher enabled" : "watcher skipped");
  summary.push(ranSetupSigning ? "helper signed with user cert" : "helper signing skipped");
  summary.push(ingested ? "archive indexed" : "archive skipped");
  summary.push(installedSkill ? "agent skill installed" : "skill skipped");
  info(`bootstrap done: ${summary.join("; ")}`);

  return {
    exitCode: r.exitCode,
    startedOllama,
    pulledModel,
    warmedPermissions,
    installedWatcher,
    ingested,
    installedSkill,
    ranSetupSigning,
    doctorOutput: r.output,
  };
}

/**
 * Default interactive prompt for the bootstrap-time signing flow.
 *
 * - Writes the question to stderr (so it survives stdout-redirected
 *   invocations).
 * - Reads one line from stdin. Yes-ish answers ("y", "Y", "yes") →
 *   true; everything else (including EOF / empty) → false.
 *
 * We deliberately don't pull in a heavyweight prompt library; this
 * is a single y/N gate on the happy path. Non-TTY stdin (CI,
 * Homebrew background install) reads EOF instantly and returns
 * false, which is the safer default.
 */
async function defaultPromptForSigning(): Promise<boolean> {
  process.stderr.write(
    "\nSystem audio recording requires re-signing the helper with your own Apple ID\n" +
      "(free, but requires Xcode). Mic-only recording works without setup.\n" +
      "\n" +
      "Set up signing now? [y/N]: ",
  );
  const answer = await readOneStdinLine();
  return /^y(es)?$/i.test(answer.trim());
}

function readOneStdinLine(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        cleanup();
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buf);
    };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      try {
        process.stdin.pause();
      } catch {
        // best-effort
      }
    };
    try {
      process.stdin.resume();
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
    } catch {
      // stdin isn't readable (e.g. detached) — treat as "no".
      cleanup();
      resolve("");
    }
  });
}

/**
 * Resolve the stable Homebrew symlink path for the swrag binary.
 *
 * The launchd plists embed this path; the symlink is rewired by
 * `brew upgrade superwhisper-rag` while the version-specific Cellar
 * realpath would point at a deleted directory after `brew cleanup`.
 *
 * Duplicated from `cli.ts::resolveBinPath` intentionally — the CLI's
 * version reaches into `process.execPath` which we don't want
 * bootstrap (a library function) to depend on uniformly.
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

/**
 * Pretty-print a one-line summary of macOS permission state so the
 * user sees what landed during the warm-up step.
 */
function logPermissionsSummary(perms: Permissions): void {
  const automationStates = Object.values(perms.automation);
  const automationGranted = automationStates.filter((s) => s === "granted").length;
  const automationTotal = automationStates.length;
  const parts = [
    `mic=${perms.microphone}`,
    `screen=${perms.screen_recording}`,
    `automation=${automationGranted}/${automationTotal} granted`,
  ];
  info(`bootstrap: permissions — ${parts.join(", ")}`);
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
