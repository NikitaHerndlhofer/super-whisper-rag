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
 * Decision matrix for an existing on-disk SKILL.md:
 *
 *  | existing | tracked sha    | action                                |
 *  | -------- | -------------- | ------------------------------------- |
 *  | == SKILL_MD              | irrelevant     | mark tracked = bundled, no-op write |
 *  | != SKILL_MD              | null (legacy)  | back up, overwrite, set tracked     |
 *  | != SKILL_MD              | == existing    | overwrite, set tracked              |
 *  | != SKILL_MD              | != existing    | refuse (user-edited)                |
 *
 * The legacy branch (null tracked sha) was previously bundled with the
 * user-edited branch, which left users who upgraded from a pre-tracking
 * version of swrag stuck on stale skills forever — auto-refresh would
 * never fire because tracked stayed null. The fix is to back up the
 * old content (preserving any genuine edits as a sibling file) and then
 * write the new bundled content, restoring the normal refresh cycle.
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
        if (tracked == null) {
          // Legacy install: file exists but pre-dates the tracking
          // mechanism. We can't tell from sha alone whether it's
          // stock content from an older release or has user edits, so
          // be conservative — back it up first, then refresh. If the
          // user had edits, the backup preserves them; if it was
          // stock content, the backup is harmless extra disk.
          const backup = await uniqueBackupPath(path);
          await rename(path, backup);
          await writeFile(path, SKILL_MD, "utf8");
          setConfig(archive, trackedHashKey(path), bundledSha);
          info(`refreshed legacy skill at ${path}; prior content backed up to ${backup}`);
          out.push({ path, refreshed: true });
          continue;
        }
        if (tracked !== existingSha) {
          // We did record a hash previously, but the on-disk content
          // has drifted from what we wrote. User edited it — refuse
          // to overwrite. Manual `swrag install-skill` is the escape
          // hatch; it backs up the current file and resumes the
          // auto-refresh cycle.
          out.push({ path, refreshed: false });
          continue;
        }
        await writeFile(path, SKILL_MD, "utf8");
        setConfig(archive, trackedHashKey(path), bundledSha);
        out.push({ path, refreshed: true });
      } catch {
        // best-effort — don't crash the ingest pipeline over a stale skill.
        out.push({ path, refreshed: false });
      }
    }
  });
  return out;
}
