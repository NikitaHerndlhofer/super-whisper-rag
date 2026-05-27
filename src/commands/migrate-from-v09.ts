/**
 * Tear down launchd plists left over from a v0.9.x install.
 *
 * v0.9.12 installed two agents to run the meeting capture pipeline:
 *
 *   - `com.superwhisper-rag.meeting-watch`   → headless watcher
 *   - `com.superwhisper-rag.meeting-menubar` → menubar UI
 *
 * Pre-v0.7.0 also installed:
 *
 *   - `com.superwhisper-rag.sync`           → hourly `swrag index` agent
 *     (replaced in v1.0 by the new event-driven watch agent)
 *
 * v1.0 removes the meeting pipeline entirely and switches the
 * background-sync mechanism from a periodic agent to a single
 * event-driven watch agent. None of the old plists are valid after
 * upgrade — the `ProgramArguments` reference subcommands the binary
 * no longer exports (`meeting watch`, `meeting menubar`, `index` for
 * the periodic agent). Leaving them on disk causes launchd to spin up
 * a dead binary every few seconds, accumulate exit logs, and
 * eventually trigger macOS's "respawning too quickly" backoff.
 *
 * This migration:
 *   1. For each legacy label: best-effort `launchctl bootout` the
 *      running instance (so launchd releases the unit cleanly), then
 *      `unlink` the plist on disk.
 *   2. Tolerates any `bootout` failure — across macOS versions the
 *      exit code isn't a reliable signal of "service not loaded" vs
 *      "real failure", and either way removing the plist file is the
 *      operation that matters.
 *   3. Idempotent — safe to re-run on a system where the cleanup has
 *      already happened.
 *
 * Returns the list of plists that were removed in this run, for log
 * surface area / test introspection. An empty list means there was
 * nothing to do.
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { info } from "../log.ts";
import { run } from "../spawn.ts";

const LEGACY_LABELS = [
  "com.superwhisper-rag.meeting-watch",
  "com.superwhisper-rag.meeting-menubar",
  // Pre-v0.7.0 periodic sync agent. New install uses
  // `com.superwhisper-rag.watch` (different label, so no collision).
  "com.superwhisper-rag.sync",
] as const;

export interface MigrateOptions {
  /**
   * Override the LaunchAgents dir for tests. Production code path
   * uses `~/Library/LaunchAgents`.
   */
  launchAgentsDir?: string;
  /**
   * Override the bootout runner for tests. Production code shells out
   * to `launchctl bootout gui/<uid>/<label>` and ignores the exit code
   * (see module docstring).
   */
  bootout?: (label: string) => void;
}

export async function migrateFromV09(opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  const bootout = opts.bootout ?? defaultBootout;
  const removed: string[] = [];
  for (const label of LEGACY_LABELS) {
    const plistPath = join(dir, `${label}.plist`);
    if (!existsSync(plistPath)) continue;
    info(`migrate-from-v09: bootout + remove ${label}`);
    try {
      bootout(label);
    } catch {
      // `bootout` failures are not actionable — see module docstring.
      // Continue to the unlink, which is the operation that matters.
    }
    await unlink(plistPath);
    removed.push(plistPath);
  }
  return removed;
}

function defaultBootout(label: string): void {
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error(
      "cannot determine current uid; launchctl bootout requires it. " +
        "Run `swrag bootstrap` from your interactive shell.",
    );
  }
  run(["launchctl", "bootout", `gui/${uid}/${label}`], { timeoutMs: 5_000 });
}
