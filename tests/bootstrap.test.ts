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
    installSync: async () => {},
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
        ingest: async () => {
          order.push("ingest");
        },
        installSync: async () => {
          order.push("install-sync");
        },
        installAgentSkill: async () => {
          order.push("install-skill");
        },
      }),
    );
    // Order is the spec: ollama → model → ingest → sync → skill.
    expect(order).toEqual([
      "start-ollama",
      "pull-model",
      "ingest",
      "install-sync",
      "install-skill",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.startedOllama).toBe(true);
    expect(r.pulledModel).toBe(true);
    expect(r.ingested).toBe(true);
    expect(r.installedSync).toBe(true);
    expect(r.installedSkill).toBe(true);
  });

  test("no-op-friendly: nothing executes when everything is already in good shape", async () => {
    let startCalls = 0;
    let pullCalls = 0;
    let syncCalls = 0;
    let skillCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        startOllama: async () => {
          startCalls++;
        },
        pullModel: async () => {
          pullCalls++;
        },
        installSync: async () => {
          syncCalls++;
        },
        installAgentSkill: async () => {
          skillCalls++;
        },
      }),
    );
    expect(startCalls).toBe(0);
    expect(pullCalls).toBe(0);
    // Sync + skill always run (they're idempotent themselves). The
    // *bootstrap* doesn't need to know whether they were already
    // installed because their internal install logic handles that.
    expect(syncCalls).toBe(1);
    expect(skillCalls).toBe(1);
    expect(r.startedOllama).toBe(false);
    expect(r.pulledModel).toBe(false);
    expect(r.ingested).toBe(true);
    expect(r.installedSync).toBe(true);
    expect(r.installedSkill).toBe(true);
    expect(r.exitCode).toBe(0);
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
        installSync: async () => {
          throw new Error("no stable bin path (dev mode)");
        },
        installAgentSkill: async () => {
          skillRan = true;
        },
      }),
    );
    expect(r.installedSync).toBe(false);
    expect(skillRan).toBe(true);
    expect(r.installedSkill).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("skipSync / skipSkill flags do what they say", async () => {
    let syncCalls = 0;
    let skillCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        skipSync: true,
        skipSkill: true,
        installSync: async () => {
          syncCalls++;
        },
        installAgentSkill: async () => {
          skillCalls++;
        },
      }),
    );
    expect(syncCalls).toBe(0);
    expect(skillCalls).toBe(0);
    expect(r.installedSync).toBe(false);
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
