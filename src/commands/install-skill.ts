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
export async function installSkill(archivePath: string): Promise<SkillInstallOutcome[]> {
  const out: SkillInstallOutcome[] = [];
  const bundledSha = sha256(SKILL_MD);
  await withArchive(archivePath, {}, async (archive) => {
    for (const path of SKILL_TARGETS) {
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
 * Refusal rules — keep these in mind before changing this function:
 *
 *  1. We only touch files that already exist. Users who never ran
 *     `swrag install-skill` are not opted in, and stay that way.
 *  2. We only overwrite if the current on-disk content matches the
 *     hash of what we last wrote. The moment the user edits their
 *     SKILL.md, the hash mismatches and we stop touching the file —
 *     because we cannot tell whether they want our updates merged in
 *     or not. (Manual `swrag install-skill` is the escape hatch; it
 *     backs the current file up and resumes the auto-refresh cycle.)
 */
export async function refreshInstalledSkills(
  archivePath: string,
): Promise<{ path: string; refreshed: boolean }[]> {
  const out: { path: string; refreshed: boolean }[] = [];
  await withArchive(archivePath, {}, async (archive) => {
    const bundledSha = sha256(SKILL_MD);
    for (const path of SKILL_TARGETS) {
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
        if (tracked == null || tracked !== existingSha) {
          // Either we've never recorded a hash (legacy install) or the
          // user has edited their SKILL.md since we last wrote it.
          // Either way, refuse to overwrite. If they want our updates
          // they can re-run `swrag install-skill`, which backs up
          // their version.
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
