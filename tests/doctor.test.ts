import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runDoctor } from "../src/commands/doctor.ts";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { makeEnv, stubEmbed, type TestEnv } from "./helpers.ts";

/**
 * `runDoctor` is deliberately exercise-the-orchestration: the
 * substantial checks (sqlite3 binary, sqlite-vec loadable, Ollama
 * reachability) exercise real system state and are covered by their
 * underlying modules' tests. Here we focus on the v1.0 wiring:
 *
 *   - the watch-agent check is plumbed through `probeWatchAgent`
 *   - the check list reaches its expected size when the archive is
 *     populated (7 checks: sqlite3 binary, custom build, vec
 *     extension, ollama, archive present, data version, chunk
 *     coverage, watch agent → "sqlite3 binary (extension-capable)"
 *     and "bun:sqlite custom build" are two separate checks, so the
 *     total is actually 8 in practice).
 */

let env: TestEnv;

beforeEach(async () => {
  env = makeEnv();
  await ensureFresh({
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  });
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

describe("runDoctor watch-agent check", () => {
  test("reports loaded when the probe returns true; ok overall depends on other checks", async () => {
    const r = await runDoctor({
      ollamaHost: "http://127.0.0.1:0",
      embedModel: "test-model",
      archive: env.archive,
      sourceDb: env.sourceDb,
      probeWatchAgent: () => true,
    });
    expect(r.output).toContain("watch agent (launchd)");
    expect(r.output).toContain("com.superwhisper-rag.watch loaded");
    // Ollama isn't reachable in tests, so overall exit code is non-zero.
    // What we care about here is the watch row's specific shape.
    expect(r.output).toMatch(/\[ok\s*\] watch agent \(launchd\)/);
  });

  test("reports not-loaded with the enable-watch hint", async () => {
    const r = await runDoctor({
      ollamaHost: "http://127.0.0.1:0",
      embedModel: "test-model",
      archive: env.archive,
      sourceDb: env.sourceDb,
      probeWatchAgent: () => false,
    });
    expect(r.output).toContain("com.superwhisper-rag.watch not loaded");
    expect(r.output).toContain("hint: swrag enable-watch");
    expect(r.exitCode).not.toBe(0);
  });
});

describe("runDoctor check list", () => {
  test("populated archive triggers archive/data-version/chunk-coverage AND watch checks", async () => {
    const r = await runDoctor({
      ollamaHost: "http://127.0.0.1:0",
      embedModel: "test-model",
      archive: env.archive,
      sourceDb: env.sourceDb,
      probeWatchAgent: () => true,
    });
    // Each row prefixes with either "[ok  ]" or "[FAIL]" — count them
    // to confirm the full set is present. (The exact tally depends on
    // whether sqlite3 is installed locally; we check for presence of
    // the new rows specifically.)
    expect(r.output).toContain("archive present");
    expect(r.output).toContain("data version");
    expect(r.output).toContain("chunk coverage");
    expect(r.output).toContain("watch agent (launchd)");
    // Make sure we don't accidentally still ship the old sync row.
    expect(r.output).not.toContain("sync agent");
  });
});
