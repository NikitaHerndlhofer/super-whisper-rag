import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfig, setConfig, withArchive } from "../archive/open.ts";
import { info } from "../log.ts";
import { DEFAULTS } from "../paths.ts";
import { SKILL_MD } from "../skill.ts";

export interface SkillInstallOutcome {
  path: string;
  action: "wrote" | "unchanged" | "backed-up";
}

const SKILL_TARGETS = [
  join(DEFAULTS.cursorSkillDir, "SKILL.md"),
  join(DEFAULTS.claudeSkillDir, "SKILL.md"),
];

/**
 * Key under which we record the SHA-256 of the SKILL.md body we last
 * wrote at `path`. `refreshInstalledSkills` compares the current
 * on-disk content's hash to this value to decide whether the user has
 * customised the file (don't overwrite) or it's still the bundled
 * content (safe to refresh in place on a binary upgrade).
 */
function trackedHashKey(path: string): string {
  return `skill_last_written_sha:${path}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Install the bundled `SKILL.md` to **both** Cursor and Claude Code's
 * machine-level skill directories. The skill is manual-invocation only
 * (frontmatter sets `disable-model-invocation: true`) — agents cannot
 * load it autonomously, the user explicitly summons it.
 *
 * Writing to both locations unconditionally is harmless: a runtime that
 * isn't installed simply never reads the file, and the file itself is
 * <10 KB. There's no `--target` flag because there's nothing useful for
 * the user to choose between.
 */
export async function installSkill(
  archivePath: string,
  targets: readonly string[] = SKILL_TARGETS,
): Promise<SkillInstallOutcome[]> {
  const out: SkillInstallOutcome[] = [];
  const bundledSha = sha256(SKILL_MD);
  await withArchive(archivePath, {}, async (archive) => {
    for (const path of targets) {
      out.push(await writeSkill(path));
      setConfig(archive, trackedHashKey(path), bundledSha);
    }
  });
  return out;
}

async function writeSkill(path: string): Promise<SkillInstallOutcome> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = await readFile(path, "utf8");
    if (existing === SKILL_MD) {
      return { path, action: "unchanged" };
    }
    const backup = await uniqueBackupPath(path);
    await rename(path, backup);
    await writeFile(path, SKILL_MD, "utf8");
    info(`backed up existing skill to ${backup}`);
    return { path, action: "backed-up" };
  }
  await writeFile(path, SKILL_MD, "utf8");
  return { path, action: "wrote" };
}

/**
 * Produce a backup path that doesn't collide with any existing file.
 * Date.now() is millisecond-resolution and two `swrag install-skill`
 * invocations within the same millisecond (script, retry loop) used to
 * overwrite each other's backup. Append a process pid plus a counter to
 * settle ties.
 */
async function uniqueBackupPath(path: string): Promise<string> {
  const base = `${path}.bak.${Date.now()}.${process.pid}`;
  if (!existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}.${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`ran out of backup slot candidates for ${path}`);
}

/**
 * Silently refresh any already-installed skill file whose content has
 * drifted from the bundled `SKILL_MD` (typically because the binary was
 * upgraded via `brew upgrade superwhisper-rag` and the new release ships
 * an updated cookbook). Called on every `swrag index` tick.
 *
 * Decision matrix for an existing on-disk SKILL.md (`existing`, hashed
 * to `existingSha`; archive-stored `tracked`; binary-bundled `bundled`):
 *
 *  | existing       | tracked vs sha                     | action                            |
 *  | -------------- | ---------------------------------- | --------------------------------- |
 *  | == SKILL_MD    | irrelevant                         | heal tracked = bundled, no-op     |
 *  | != SKILL_MD    | tracked == bundled                 | **refuse** (user edited after our last write) |
 *  | != SKILL_MD    | tracked == existing                | refresh in place, set tracked     |
 *  | != SKILL_MD    | tracked == null                    | back up, refresh, set tracked     |
 *  | != SKILL_MD    | tracked != existing && != bundled  | back up, refresh, set tracked     |
 *
 * History of this gating:
 *
 *  v0.6.0–v0.6.1: refused on anything that wasn't "tracked == existing",
 *    which never fired auto-refresh on archives whose tracked sha was
 *    null (legacy installs).
 *  v0.6.2: split out `tracked == null` to backup-refresh, but missed
 *    archives where tracked exists but is wholesale unrelated to
 *    on-disk content (drift state — typically the symptom of a prior
 *    install path that updated tracked without keeping the file in
 *    sync, or vice versa).
 *  v0.6.3 (this version): only one case still refuses — `tracked ==
 *    bundled`, the unambiguous "we wrote SKILL_MD and the user edited
 *    it since" signal. Every other shape of drift gets the back-up-
 *    and-refresh treatment, trusting the timestamped .bak siblings as
 *    the user's recovery surface.
 *
 * The trade-off: across multiple binary upgrades, a user who has
 * genuinely edited their SKILL.md before the upgrade chain will hit the
 * drift branch on the second upgrade (because tracked still reflects
 * the version-before-their-edit, not the latest bundled). Their edit
 * gets backed up and overwritten. Mitigated by the explicit `info(...)`
 * log line and the discoverable `.bak.<timestamp>` filename — the user
 * can always recover from there. We accept this in exchange for the
 * upgrade path actually working for archives in drift states.
 */
export async function refreshInstalledSkills(
  archivePath: string,
  targets: readonly string[] = SKILL_TARGETS,
): Promise<{ path: string; refreshed: boolean }[]> {
  const out: { path: string; refreshed: boolean }[] = [];
  await withArchive(archivePath, {}, async (archive) => {
    const bundledSha = sha256(SKILL_MD);
    for (const path of targets) {
      if (!existsSync(path)) {
        out.push({ path, refreshed: false });
        continue;
      }
      try {
        const existing = await readFile(path, "utf8");
        if (existing === SKILL_MD) {
          // Already up to date. Make sure the tracked hash reflects
          // reality so user edits from this point onward are
          // protected.
          setConfig(archive, trackedHashKey(path), bundledSha);
          out.push({ path, refreshed: false });
          continue;
        }
        const tracked = getConfig(archive, trackedHashKey(path));
        const existingSha = sha256(existing);
        if (tracked === bundledSha) {
          // We previously wrote exactly this binary's SKILL_MD and the
          // user has edited it since. Refuse — manual
          // `swrag install-skill` is the escape hatch (it backs the
          // current file up and resumes the auto-refresh cycle).
          out.push({ path, refreshed: false });
          continue;
        }
        if (tracked === existingSha) {
          // Plain binary upgrade: on-disk is byte-identical to what we
          // last wrote. Refresh in place; no backup needed because we
          // wrote it ourselves.
          await writeFile(path, SKILL_MD, "utf8");
          setConfig(archive, trackedHashKey(path), bundledSha);
          out.push({ path, refreshed: true });
          continue;
        }
        // Drift or legacy: tracked is null, or it points at content
        // that's no longer on disk. Either way we can't tell whether
        // the on-disk content is stock-from-an-older-release or
        // user-edited, so be conservative — back it up first, then
        // refresh. The .bak preserves any edits the user might have
        // had.
        const backup = await uniqueBackupPath(path);
        await rename(path, backup);
        await writeFile(path, SKILL_MD, "utf8");
        setConfig(archive, trackedHashKey(path), bundledSha);
        info(`refreshed drifted skill at ${path}; prior content backed up to ${backup}`);
        out.push({ path, refreshed: true });
      } catch {
        // best-effort — don't crash the ingest pipeline over a stale skill.
        out.push({ path, refreshed: false });
      }
    }
  });
  return out;
}
