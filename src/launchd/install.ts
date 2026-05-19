import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { DEFAULTS } from "../paths.ts";
import { run } from "../spawn.ts";
import { PLIST_LABEL, renderPlist } from "./plist.ts";

export interface InstallSyncOptions {
  binPath: string;
  logPath?: string;
  intervalSeconds?: number;
}

export async function installLaunchAgent(opts: InstallSyncOptions): Promise<string> {
  const plistPath = DEFAULTS.launchPlist;
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(dirname(opts.logPath ?? DEFAULTS.logFile), { recursive: true });

  const xml = renderPlist({
    binPath: opts.binPath,
    user: userInfo().username,
    logPath: opts.logPath ?? DEFAULTS.logFile,
    intervalSeconds: opts.intervalSeconds,
  });
  await writeFile(plistPath, xml, "utf8");

  // Make idempotent: bootout any existing instance first.
  bootout();

  const r = run(["launchctl", "bootstrap", `gui/${currentUid()}`, plistPath], {
    timeoutMs: 10_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`launchctl bootstrap failed: ${r.stderr}`);
  }
  return plistPath;
}

export async function uninstallLaunchAgent(): Promise<boolean> {
  const plistPath = DEFAULTS.launchPlist;
  let removedRunning = false;
  if (existsSync(plistPath)) {
    removedRunning = bootout();
    await unlink(plistPath);
  }
  return removedRunning;
}

/**
 * `launchctl bootout` the running instance, if any. The plist on disk is
 * not consulted — `launchctl` looks the service up by label.
 */
function bootout(): boolean {
  const r = run(["launchctl", "bootout", `gui/${currentUid()}/${PLIST_LABEL}`], {
    timeoutMs: 5_000,
  });
  // Exit non-zero is fine — service may not have been loaded.
  return r.exitCode === 0;
}

/**
 * The current user's uid. `process.getuid` exists on every supported
 * platform (we ship Darwin only), so failure here is exceptional and
 * we'd rather error out than guess `501` and bootstrap into another
 * user's session.
 */
function currentUid(): number {
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error(
      "cannot determine current uid; launchctl bootstrap requires it. " +
        "This usually means the swrag binary is running in an environment " +
        "where process.getuid is not available.",
    );
  }
  return uid;
}
