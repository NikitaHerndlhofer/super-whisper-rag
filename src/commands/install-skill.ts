import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  await mkdir(join(path, ".."), { recursive: true });
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
