import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { DEFAULTS } from "../paths.ts";
import { run } from "../spawn.ts";
import { PLIST_LABEL, renderPlist } from "./plist.ts";

export interface InstallWatchOptions {
  binPath: string;
  logPath?: string;
  throttleSeconds?: number;
}

export async function installLaunchAgent(opts: InstallWatchOptions): Promise<string> {
  const plistPath = DEFAULTS.launchPlist;
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(dirname(opts.logPath ?? DEFAULTS.logFile), { recursive: true });

  const xml = renderPlist({
    binPath: opts.binPath,
    user: userInfo().username,
    logPath: opts.logPath ?? DEFAULTS.logFile,
    throttleSeconds: opts.throttleSeconds,
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

/**
 * Returns true iff a plist was present on disk and got removed. Whether
 * the launchd service itself was actually running before the bootout is
 * deliberately not reported — `launchctl bootout`'s exit code isn't a
 * reliable signal across macOS versions (sometimes 0 with "no such
 * service", sometimes non-zero). The caller's UI message should
 * therefore phrase the absence-case as "was not installed" only when the
 * plist file was missing.
 */
export async function uninstallLaunchAgent(): Promise<boolean> {
  const plistPath = DEFAULTS.launchPlist;
  if (!existsSync(plistPath)) return false;
  bootout();
  await unlink(plistPath);
  return true;
}

/**
 * `launchctl bootout` the running instance, if any. The plist on disk is
 * not consulted — `launchctl` looks the service up by label. Exit code
 * is ignored: across macOS versions it's not consistent whether
 * "service wasn't loaded" is success or failure, and either way we
 * don't care for our purposes.
 */
function bootout(): void {
  run(["launchctl", "bootout", `gui/${currentUid()}/${PLIST_LABEL}`], {
    timeoutMs: 5_000,
  });
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
