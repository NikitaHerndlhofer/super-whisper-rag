/**
 * launchd install/uninstall helpers.
 *
 * Generic primitives:
 *
 *   - `installLaunchAgent({ label, plistXml })`
 *   - `uninstallLaunchAgent({ label })`
 *
 * `enable-watcher` (Phase 4) uses these directly to install two
 * plists (daemon + menubar) atomically.
 *
 * The label drives the plist path: every install lands at
 * `~/Library/LaunchAgents/<label>.plist`. Uninstall is idempotent —
 * removing a plist that isn't installed succeeds silently.
 */
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../spawn.ts";

/* -------------------------------------------------------------------------- */
/* Generic primitives                                                         */
/* -------------------------------------------------------------------------- */

export interface InstallLaunchAgentOptions {
  label: string;
  plistXml: string;
}

/**
 * Idempotently install a launch agent: write the plist file under
 * `~/Library/LaunchAgents/`, then `launchctl bootstrap` it. Any
 * existing agent under the same label is `bootout`-ed first so
 * re-running the command picks up the new XML.
 *
 * Returns the absolute plist path on success; throws on failure.
 */
export async function installLaunchAgent(opts: InstallLaunchAgentOptions): Promise<string> {
  const plistPath = plistPathForLabel(opts.label);
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, opts.plistXml, "utf8");

  bootoutLabel(opts.label);

  const r = run(["launchctl", "bootstrap", `gui/${currentUid()}`, plistPath], {
    timeoutMs: 10_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`launchctl bootstrap ${opts.label} failed: ${r.stderr}`);
  }
  return plistPath;
}

/**
 * Idempotently uninstall a launch agent by label. Returns true if a
 * plist file was present (and is now removed); false if the plist
 * was already absent.
 *
 * The launchd side of the world is best-effort: `launchctl bootout`'s
 * exit code is not consistent across macOS versions for "no such
 * service", so we always run it and ignore the result. The plist
 * file is the source of truth.
 */
export async function uninstallLaunchAgent(opts: { label: string }): Promise<boolean> {
  const plistPath = plistPathForLabel(opts.label);
  bootoutLabel(opts.label);
  if (!existsSync(plistPath)) return false;
  await unlink(plistPath);
  return true;
}

/**
 * Plist path for `<label>` under `~/Library/LaunchAgents/`. The
 * `.plist` suffix is appended automatically — labels never include
 * one.
 */
export function plistPathForLabel(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function bootoutLabel(label: string): void {
  run(["launchctl", "bootout", `gui/${currentUid()}/${label}`], {
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
