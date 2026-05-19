import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { info } from "../log.ts";
import { DEFAULTS } from "../paths.ts";
import { SKILL_MD } from "../skill.ts";

export interface SkillInstallOutcome {
  path: string;
  action: "wrote" | "unchanged" | "backed-up";
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
export async function installSkill(): Promise<SkillInstallOutcome[]> {
  const targets = [
    join(DEFAULTS.cursorSkillDir, "SKILL.md"),
    join(DEFAULTS.claudeSkillDir, "SKILL.md"),
  ];
  const out: SkillInstallOutcome[] = [];
  for (const path of targets) {
    out.push(await writeSkill(path));
  }
  return out;
}

async function writeSkill(path: string): Promise<SkillInstallOutcome> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = await readFile(path, "utf8");
    if (existing === SKILL_MD) {
      return { path, action: "unchanged" };
    }
    const backup = `${path}.bak.${Date.now()}`;
    await rename(path, backup);
    await writeFile(path, SKILL_MD, "utf8");
    info(`backed up existing skill to ${backup}`);
    return { path, action: "backed-up" };
  }
  await writeFile(path, SKILL_MD, "utf8");
  return { path, action: "wrote" };
}

/**
 * Silently refresh any already-installed skill file whose content has
 * drifted from the bundled `SKILL_MD` (typically because the binary was
 * upgraded via `brew upgrade superwhisper-rag` and the new release ships
 * an updated cookbook). Called on every `swrag index` tick, so users get
 * fresh skill content within one hourly cycle of any upgrade.
 *
 * Only touches files that already exist — users who never ran
 * `swrag install-skill` are not opted in, and stay that way.
 */
export async function refreshInstalledSkills(): Promise<{ path: string; refreshed: boolean }[]> {
  const targets = [
    join(DEFAULTS.cursorSkillDir, "SKILL.md"),
    join(DEFAULTS.claudeSkillDir, "SKILL.md"),
  ];
  const out: { path: string; refreshed: boolean }[] = [];
  for (const path of targets) {
    if (!existsSync(path)) {
      out.push({ path, refreshed: false });
      continue;
    }
    try {
      const existing = await readFile(path, "utf8");
      if (existing === SKILL_MD) {
        out.push({ path, refreshed: false });
        continue;
      }
      // Auto-refresh: skip the .bak.<ts> backup chain here. The user
      // opted in to the skill once; we don't want to fill their disk
      // with one backup per release. The user can recover content via
      // `git log` on the source repo if they really care.
      await writeFile(path, SKILL_MD, "utf8");
      out.push({ path, refreshed: true });
    } catch {
      // best-effort — don't crash the ingest pipeline over a stale skill.
      out.push({ path, refreshed: false });
    }
  }
  return out;
}
