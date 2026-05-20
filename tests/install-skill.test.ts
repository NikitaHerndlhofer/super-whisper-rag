/**
 * Tests for `installSkill` + `refreshInstalledSkills`.
 *
 * The CLI calls these with the real `~/.cursor/skills/...` and
 * `~/.claude/skills/...` paths from `DEFAULTS`. Both functions accept an
 * optional `targets` parameter so tests can point them at a tmp dir
 * instead of mutating the developer's machine.
 *
 * The decision matrix being verified is in the docblock above
 * `refreshInstalledSkills` — bug fix in v0.6.2 separated the legacy-
 * install case (refresh-with-backup) from the user-edited case (refuse).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { installSkill, refreshInstalledSkills } from "../src/commands/install-skill.ts";
import { ensureExtensionCapableSqlite, openArchive } from "../src/archive/open.ts";
import { SKILL_MD } from "../src/skill.ts";

ensureExtensionCapableSqlite();

interface Env {
  workDir: string;
  archive: string;
  skillA: string;
  skillB: string;
  targets: readonly string[];
}

let env: Env;

beforeEach(() => {
  const workDir = mkdtempSync(join(tmpdir(), "swrag-install-skill-"));
  const archive = join(workDir, "archive", "swrag.sqlite");
  const skillA = join(workDir, "cursor", "SKILL.md");
  const skillB = join(workDir, "claude", "SKILL.md");
  // Pre-create parent dirs so the tests that seed state via
  // `writeFileSync` don't trip over a missing directory. The
  // installSkill code path creates its own dirs lazily; the test
  // seeding path goes around it.
  mkdirSync(dirname(skillA), { recursive: true });
  mkdirSync(dirname(skillB), { recursive: true });
  // Initialise the archive so the migration runner has somewhere to
  // write the tracked-sha config keys.
  openArchive(archive).close();
  env = { workDir, archive, skillA, skillB, targets: [skillA, skillB] };
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

function trackedShaFor(path: string): string | undefined {
  const db = openArchive(env.archive);
  try {
    const raw: unknown = db
      .prepare("SELECT value FROM config WHERE key = ?")
      .get(`skill_last_written_sha:${path}`);
    if (raw == null) return undefined;
    return z.object({ value: z.string() }).parse(raw).value;
  } finally {
    db.close();
  }
}

function writeTracked(path: string, sha: string): void {
  const db = openArchive(env.archive);
  try {
    db.prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(`skill_last_written_sha:${path}`, sha);
  } finally {
    db.close();
  }
}

import { createHash } from "node:crypto";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function listBackups(path: string): string[] {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) return [];
  // Bun-friendly directory enumeration via node:fs synchronous readdir.
  const { readdirSync } = require("node:fs");
  const entries: string[] = readdirSync(dir);
  return entries.filter((e) => e.startsWith("SKILL.md.bak.")).map((e) => join(dir, e));
}

describe("installSkill", () => {
  test("writes both targets and records their sha", async () => {
    const results = await installSkill(env.archive, env.targets);
    expect(results.map((r) => r.action)).toEqual(["wrote", "wrote"]);
    expect(readFileSync(env.skillA, "utf8")).toBe(SKILL_MD);
    expect(readFileSync(env.skillB, "utf8")).toBe(SKILL_MD);
    const bundledSha = sha256(SKILL_MD);
    expect(trackedShaFor(env.skillA)).toBe(bundledSha);
    expect(trackedShaFor(env.skillB)).toBe(bundledSha);
  });

  test("backs up an existing file before overwriting", async () => {
    writeFileSync(env.skillA, "totally custom content the user wrote", "utf8");
    // skillB doesn't exist yet — verify it lands as a fresh `wrote`.
    const results = await installSkill(env.archive, env.targets);
    expect(results[0]?.action).toBe("backed-up");
    expect(results[1]?.action).toBe("wrote");
    expect(readFileSync(env.skillA, "utf8")).toBe(SKILL_MD);
    const backups = listBackups(env.skillA);
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(backups[0] ?? "", "utf8")).toBe("totally custom content the user wrote");
  });

  test("is a no-op (`unchanged`) when on-disk already equals SKILL_MD", async () => {
    writeFileSync(env.skillA, SKILL_MD, "utf8");
    writeFileSync(env.skillB, SKILL_MD, "utf8");
    const results = await installSkill(env.archive, env.targets);
    expect(results.map((r) => r.action)).toEqual(["unchanged", "unchanged"]);
    // No backups created.
    expect(listBackups(env.skillA)).toEqual([]);
    expect(listBackups(env.skillB)).toEqual([]);
  });
});

describe("refreshInstalledSkills decision matrix", () => {
  test("non-existent file → no-op (we don't opt the user in)", async () => {
    const results = await refreshInstalledSkills(env.archive, env.targets);
    expect(results.every((r) => !r.refreshed)).toBe(true);
    expect(existsSync(env.skillA)).toBe(false);
    expect(existsSync(env.skillB)).toBe(false);
  });

  test("on-disk == SKILL_MD → no-op write, but tracked sha is captured", async () => {
    writeFileSync(env.skillA, SKILL_MD, "utf8");
    writeFileSync(env.skillB, SKILL_MD, "utf8");
    const results = await refreshInstalledSkills(env.archive, env.targets);
    // refreshed=false because we didn't change content; but tracking
    // was updated so the next genuine drift is detectable.
    expect(results.every((r) => !r.refreshed)).toBe(true);
    const bundledSha = sha256(SKILL_MD);
    expect(trackedShaFor(env.skillA)).toBe(bundledSha);
    expect(trackedShaFor(env.skillB)).toBe(bundledSha);
  });

  test("on-disk != SKILL_MD AND tracked == null (legacy) → back up + refresh", async () => {
    // Simulate the v0.6.0-to-v0.6.1 upgrade state that blocked the
    // user's local skill refresh: file exists, content drifts from
    // current SKILL_MD, and the archive has NO tracked-sha row for it.
    const legacy = "## legacy bundled skill from an older version\n…";
    writeFileSync(env.skillA, legacy, "utf8");
    writeFileSync(env.skillB, legacy, "utf8");
    expect(trackedShaFor(env.skillA)).toBeUndefined();

    const results = await refreshInstalledSkills(env.archive, env.targets);
    expect(results.every((r) => r.refreshed)).toBe(true);
    expect(readFileSync(env.skillA, "utf8")).toBe(SKILL_MD);
    expect(readFileSync(env.skillB, "utf8")).toBe(SKILL_MD);
    // Backups preserve the prior content — if the user HAD edited it,
    // those edits are recoverable from the sibling .bak file.
    for (const target of env.targets) {
      const backups = listBackups(target);
      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(readFileSync(backups[0] ?? "", "utf8")).toBe(legacy);
    }
    // Tracking is now in place.
    const bundledSha = sha256(SKILL_MD);
    expect(trackedShaFor(env.skillA)).toBe(bundledSha);
    expect(trackedShaFor(env.skillB)).toBe(bundledSha);
  });

  test("on-disk != SKILL_MD AND tracked == sha(existing) → refresh in place (binary upgrade)", async () => {
    // Simulate a normal binary upgrade: the previous binary wrote
    // some-old-skill, tracked its sha, and now a new binary with a
    // different SKILL_MD wants to refresh.
    const oldContent = "## previously-written skill from prior binary\n…";
    writeFileSync(env.skillA, oldContent, "utf8");
    writeTracked(env.skillA, sha256(oldContent));

    const results = await refreshInstalledSkills(env.archive, [env.skillA]);
    expect(results[0]?.refreshed).toBe(true);
    expect(readFileSync(env.skillA, "utf8")).toBe(SKILL_MD);
    // No backup in the normal-upgrade path — the prior content was
    // bundled by us, not user-authored.
    expect(listBackups(env.skillA)).toEqual([]);
    expect(trackedShaFor(env.skillA)).toBe(sha256(SKILL_MD));
  });

  test("on-disk != SKILL_MD AND tracked != sha(existing) → refuse (user edited)", async () => {
    // User edited their SKILL.md after a previous install. We wrote A,
    // tracked sha(A), then user changed it to B. tracked still
    // says A, but on-disk is B. Refuse to overwrite.
    const ourPrevious = "## skill content we previously wrote\n…";
    const userEdited = "## skill the user customised\n…";
    writeFileSync(env.skillA, userEdited, "utf8");
    writeTracked(env.skillA, sha256(ourPrevious)); // tracking the old us-written sha

    const results = await refreshInstalledSkills(env.archive, [env.skillA]);
    expect(results[0]?.refreshed).toBe(false);
    expect(readFileSync(env.skillA, "utf8")).toBe(userEdited);
    // Tracked sha unchanged — we don't claim credit for the user's
    // edits.
    expect(trackedShaFor(env.skillA)).toBe(sha256(ourPrevious));
    // No backup — we didn't touch the file.
    expect(listBackups(env.skillA)).toEqual([]);
  });
});
