import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { DEFAULTS } from "../paths.ts";
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
  bootout(plistPath);

  const uid = process.getuid?.() ?? 501;
  const r = Bun.spawnSync({
    cmd: ["launchctl", "bootstrap", `gui/${uid}`, plistPath],
    timeout: 10_000,
  });
  if (r.exitCode !== 0) {
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    throw new Error(`launchctl bootstrap failed: ${stderr}`);
  }
  return plistPath;
}

export async function uninstallLaunchAgent(): Promise<boolean> {
  const plistPath = DEFAULTS.launchPlist;
  let removedRunning = false;
  if (existsSync(plistPath)) {
    removedRunning = bootout(plistPath);
    await unlink(plistPath);
  }
  return removedRunning;
}

function bootout(_plistPath: string): boolean {
  const uid = process.getuid?.() ?? 501;
  const r = Bun.spawnSync({
    cmd: ["launchctl", "bootout", `gui/${uid}/${PLIST_LABEL}`],
    timeout: 5_000,
  });
  // Exit non-zero is fine — service may not have been loaded.
  return r.exitCode === 0;
}
