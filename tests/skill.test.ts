import { describe, expect, test } from "bun:test";
import { SKILL_MD } from "../src/skill.ts";

describe("SKILL_MD", () => {
  test("has the manual-invocation frontmatter", () => {
    expect(SKILL_MD).toContain("name: superwhisper-rag");
    expect(SKILL_MD).toContain("disable-model-invocation: true");
  });

  test("splices the cookbook recipes from docs/sql-cookbook.md", () => {
    // Canary recipes spanning the start, middle, and end of the cookbook
    // block. If the splice is empty or the markers got moved, these fail.
    expect(SKILL_MD).toContain("-- 0. Discover the user's modes");
    expect(SKILL_MD).toContain("-- 1. Today's recordings, newest first");
    expect(SKILL_MD).toContain("-- 12. Reprocessing history of a recording");
  });

  test("does not leak the splice markers into the rendered skill", () => {
    expect(SKILL_MD).not.toContain("swrag:cookbook:start");
    expect(SKILL_MD).not.toContain("swrag:cookbook:end");
  });
});
