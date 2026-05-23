/**
 * `swrag meeting enable-watcher` / `disable-watcher`.
 *
 * Installs the meeting daemon + menubar as two keepalive launch
 * agents. The two-plist install is atomic: if the second plist fails,
 * the first is `launchctl bootout`-ed before the function returns so
 * the user is never left with a half-installed pair of agents.
 *
 * `enable-watcher --system-audio` also writes
 * `meeting_system_audio_default=1` AND
 * `meeting_system_audio_ack=1` into the archive config: the user has
 * acknowledged the legal warning by passing the flag (the README
 * notes this behaviour). Without `--system-audio` neither key is
 * touched.
 *
 * `disable-watcher` removes both plists. Idempotent: removing an
 * already-uninstalled pair succeeds with a structured "was not
 * installed" result.
 */
import { openArchive, setConfig } from "../archive/open.ts";
import {
  installLaunchAgent,
  type InstallLaunchAgentOptions,
  uninstallLaunchAgent,
} from "../launchd/install.ts";
import {
  MEETING_MENUBAR_PLIST_LABEL,
  MEETING_WATCH_PLIST_LABEL,
  renderPlist,
} from "../launchd/plist.ts";
import { info, warn } from "../log.ts";
import { DEFAULTS } from "../paths.ts";
import {
  CONFIG_SYSTEM_AUDIO_ACK,
  CONFIG_SYSTEM_AUDIO_DEFAULT,
} from "../meeting/daemon.ts";

export interface EnableWatcherOptions {
  binPath: string;
  archive: string;
  systemAudio?: boolean;
  /**
   * Tests / dry-runs override the installer to avoid touching real
   * launchd. The default delegates to `installLaunchAgent`.
   */
  install?: (opts: InstallLaunchAgentOptions) => Promise<string>;
  /** Override the uninstaller. Same rationale as `install`. */
  uninstall?: (opts: { label: string }) => Promise<boolean>;
  /**
   * Override the log path used by both plists. Falls back to the
   * shared swrag log file.
   */
  logPath?: string;
}

export interface EnableWatcherResult {
  watchPlist: string;
  menubarPlist: string;
  systemAudioPersisted: boolean;
}

/**
 * Install both launch agents atomically. If `installB` fails after
 * `installA` succeeded, A is `bootout`-ed before the original error
 * is re-thrown.
 */
export async function enableWatcher(opts: EnableWatcherOptions): Promise<EnableWatcherResult> {
  const install = opts.install ?? installLaunchAgent;
  const uninstall = opts.uninstall ?? uninstallLaunchAgent;
  const logPath = opts.logPath ?? DEFAULTS.logFile;

  // Persist the system-audio defaults BEFORE installing the agents.
  // If the second plist install fails and we roll back, we leave the
  // config keys in place — they're harmless without an active daemon
  // and re-running `enable-watcher --system-audio` is a no-op.
  let systemAudioPersisted = false;
  if (opts.systemAudio) {
    const db = openArchive(opts.archive, {});
    try {
      setConfig(db, CONFIG_SYSTEM_AUDIO_DEFAULT, "1");
      setConfig(db, CONFIG_SYSTEM_AUDIO_ACK, "1");
    } finally {
      db.close();
    }
    systemAudioPersisted = true;
    info("meeting watcher: persisted system-audio default + legal ack");
  }

  const watchXml = renderPlist({
    label: MEETING_WATCH_PLIST_LABEL,
    binPath: opts.binPath,
    programArguments: ["meeting", "watch"],
    logPath,
  });
  const menubarXml = renderPlist({
    label: MEETING_MENUBAR_PLIST_LABEL,
    binPath: opts.binPath,
    programArguments: ["meeting", "menubar"],
    logPath,
  });

  // 1. Install watch.
  let watchPlist: string;
  try {
    watchPlist = await install({ label: MEETING_WATCH_PLIST_LABEL, plistXml: watchXml });
  } catch (e) {
    throw new Error(
      `meeting watcher: failed to install watch agent: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  info(`meeting watcher: installed ${MEETING_WATCH_PLIST_LABEL} → ${watchPlist}`);

  // 2. Install menubar. On failure, roll back watch.
  let menubarPlist: string;
  try {
    menubarPlist = await install({ label: MEETING_MENUBAR_PLIST_LABEL, plistXml: menubarXml });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await uninstall({ label: MEETING_WATCH_PLIST_LABEL });
    } catch (rollbackErr) {
      warn(
        `meeting watcher: rollback also failed: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }`,
      );
    }
    throw new Error(`meeting watcher: failed to install menubar agent (rolled back): ${msg}`);
  }
  info(`meeting watcher: installed ${MEETING_MENUBAR_PLIST_LABEL} → ${menubarPlist}`);

  return { watchPlist, menubarPlist, systemAudioPersisted };
}

export interface DisableWatcherResult {
  watchRemoved: boolean;
  menubarRemoved: boolean;
}

/**
 * Remove both launch agents. Both calls run regardless of either's
 * outcome — we want disable-watcher to leave the system in a clean
 * state even if one half was already missing.
 */
export async function disableWatcher(opts: {
  uninstall?: (opts: { label: string }) => Promise<boolean>;
} = {}): Promise<DisableWatcherResult> {
  const uninstall = opts.uninstall ?? uninstallLaunchAgent;
  const watchRemoved = await uninstall({ label: MEETING_WATCH_PLIST_LABEL }).catch((e) => {
    warn(
      `meeting watcher: watch uninstall failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  });
  const menubarRemoved = await uninstall({ label: MEETING_MENUBAR_PLIST_LABEL }).catch((e) => {
    warn(
      `meeting watcher: menubar uninstall failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  });
  return { watchRemoved, menubarRemoved };
}
