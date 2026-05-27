import { describe, expect, test } from "bun:test";
import { runBootstrap } from "../src/commands/bootstrap.ts";

/**
 * `runBootstrap` is small and orchestrational. The substance — talking
 * to ollama, shelling out to `brew services`, running `ollama pull` —
 * is all behind dependency-injected stubs that real callers don't
 * override but tests do. We exercise the orchestration logic here and
 * trust the (already-tested) `runDoctor` for the verification step.
 */

const baseOpts = {
  ollamaHost: "http://127.0.0.1:0",
  embedModel: "test-model",
  archive: "/tmp/swrag-bootstrap-test-nope.sqlite",
  sourceDb: "/tmp/swrag-bootstrap-test-nope-source.sqlite",
  sourceDir: "/tmp/swrag-bootstrap-test-nope-dir",
  // Keep tests fast — no real `brew services` polling budget needed.
  serviceStartWaitMs: 100,
} as const;

function stubDoctorOk() {
  return Promise.resolve({ exitCode: 0, output: "stub doctor: ok\n" });
}

/**
 * Default stubs for the steps we don't care about in a particular
 * test. Avoids each test having to remember to disable real ollama,
 * real ingest, real launchd, real skill install.
 */
function withDefaults<T extends object>(over: T) {
  return {
    ...baseOpts,
    isOllamaReachable: () => Promise.resolve(true),
    startOllama: async () => {},
    pullModel: async () => {},
    checkOllamaModel: () => Promise.resolve(null),
    ingest: async () => {},
    migrateLegacy: async () => [],
    installWatch: async () => {},
    installAgentSkill: async () => {},
    doctor: stubDoctorOk,
    ...over,
  };
}

describe("runBootstrap", () => {
  test("happy path: all steps execute in order, summary flags match", async () => {
    const order: string[] = [];
    let reachabilityCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        // First call (pre-startOllama) returns false to force the
        // start-and-poll branch; subsequent calls return true so the
        // polling loop terminates.
        isOllamaReachable: () => {
          reachabilityCalls++;
          return Promise.resolve(reachabilityCalls > 1);
        },
        startOllama: async () => {
          order.push("start-ollama");
        },
        pullModel: async () => {
          order.push("pull-model");
        },
        checkOllamaModel: () => Promise.resolve('embed model "x" not pulled. Run: ollama pull x'),
        migrateLegacy: async () => {
          order.push("migrate-legacy");
          return [];
        },
        installWatch: async () => {
          order.push("install-watch");
        },
        ingest: async () => {
          order.push("ingest");
        },
        installAgentSkill: async () => {
          order.push("install-skill");
        },
      }),
    );
    // Order is the v1.0 spec: ollama → model → migrate → watch → ingest → skill.
    // (Watch goes before ingest so a slow first index doesn't delay the
    // daemon coming up.)
    expect(order).toEqual([
      "start-ollama",
      "pull-model",
      "migrate-legacy",
      "install-watch",
      "ingest",
      "install-skill",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.startedOllama).toBe(true);
    expect(r.pulledModel).toBe(true);
    expect(r.ingested).toBe(true);
    expect(r.installedWatch).toBe(true);
    expect(r.installedSkill).toBe(true);
    expect(r.legacyRemoved).toEqual([]);
  });

  test("no-op-friendly: nothing executes when everything is already in good shape", async () => {
    let startCalls = 0;
    let pullCalls = 0;
    let watchCalls = 0;
    let skillCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        startOllama: async () => {
          startCalls++;
        },
        pullModel: async () => {
          pullCalls++;
        },
        installWatch: async () => {
          watchCalls++;
        },
        installAgentSkill: async () => {
          skillCalls++;
        },
      }),
    );
    expect(startCalls).toBe(0);
    expect(pullCalls).toBe(0);
    // Watch + skill always run (they're idempotent themselves). The
    // *bootstrap* doesn't need to know whether they were already
    // installed because their internal install logic handles that.
    expect(watchCalls).toBe(1);
    expect(skillCalls).toBe(1);
    expect(r.startedOllama).toBe(false);
    expect(r.pulledModel).toBe(false);
    expect(r.ingested).toBe(true);
    expect(r.installedWatch).toBe(true);
    expect(r.installedSkill).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("v0.9 cleanup: reports which legacy plists were removed", async () => {
    const r = await runBootstrap(
      withDefaults({
        migrateLegacy: async () => [
          "/Users/x/Library/LaunchAgents/com.superwhisper-rag.meeting-watch.plist",
          "/Users/x/Library/LaunchAgents/com.superwhisper-rag.sync.plist",
        ],
      }),
    );
    expect(r.legacyRemoved).toHaveLength(2);
    expect(r.legacyRemoved[0]).toContain("meeting-watch.plist");
    expect(r.legacyRemoved[1]).toContain("sync.plist");
  });

  test("starts ollama when not reachable, then succeeds", async () => {
    let startCalls = 0;
    let reachabilityCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        isOllamaReachable: () => {
          reachabilityCalls++;
          return Promise.resolve(reachabilityCalls > 1);
        },
        startOllama: async () => {
          startCalls++;
        },
      }),
    );
    expect(startCalls).toBe(1);
    expect(r.startedOllama).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("throws if ollama doesn't come up after start", async () => {
    await expect(
      runBootstrap(
        withDefaults({
          isOllamaReachable: () => Promise.resolve(false),
        }),
      ),
    ).rejects.toThrow(/did not become reachable/);
  });

  test("propagates non-zero doctor exit codes", async () => {
    const r = await runBootstrap(
      withDefaults({
        doctor: () => Promise.resolve({ exitCode: 2, output: "stub doctor: failed\n" }),
      }),
    );
    expect(r.exitCode).toBe(2);
  });

  test("surfaces non-'not pulled' ollama errors as fatal", async () => {
    await expect(
      runBootstrap(
        withDefaults({
          checkOllamaModel: () => Promise.resolve("Ollama responded 500 at http://..."),
        }),
      ),
    ).rejects.toThrow(/ollama check failed/);
  });

  test("launchd install failure does not abort the bootstrap", async () => {
    // The launchd step is best-effort because dev runs (`bun run`)
    // don't have a stable binary path to embed in the plist. A failure
    // there shouldn't take down the whole bootstrap.
    let skillRan = false;
    const r = await runBootstrap(
      withDefaults({
        installWatch: async () => {
          throw new Error("no stable bin path (dev mode)");
        },
        installAgentSkill: async () => {
          skillRan = true;
        },
      }),
    );
    expect(r.installedWatch).toBe(false);
    expect(skillRan).toBe(true);
    expect(r.installedSkill).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("skipWatch / skipSkill flags do what they say", async () => {
    let watchCalls = 0;
    let skillCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        skipWatch: true,
        skipSkill: true,
        installWatch: async () => {
          watchCalls++;
        },
        installAgentSkill: async () => {
          skillCalls++;
        },
      }),
    );
    expect(watchCalls).toBe(0);
    expect(skillCalls).toBe(0);
    expect(r.installedWatch).toBe(false);
    expect(r.installedSkill).toBe(false);
  });

  test("ingest errors abort the bootstrap (they would leave the archive empty / broken)", async () => {
    await expect(
      runBootstrap(
        withDefaults({
          ingest: async () => {
            throw new Error("source DB not found");
          },
        }),
      ),
    ).rejects.toThrow(/source DB not found/);
  });
});
