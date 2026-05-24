import { describe, expect, test } from "bun:test";
import { runBootstrap } from "../src/commands/bootstrap.ts";
import type { Permissions } from "../src/mac/helper.ts";
import {
  MEETING_MENUBAR_PLIST_LABEL,
  MEETING_WATCH_PLIST_LABEL,
} from "../src/launchd/plist.ts";

/**
 * `runBootstrap` is small and orchestrational. The substance — talking
 * to ollama, shelling out to `brew services`, running `ollama pull`,
 * warming macOS permissions, installing the meeting-watcher launch
 * agents — is all behind dependency-injected stubs that real callers
 * don't override but tests do. We exercise the orchestration logic
 * here and trust the (already-tested) `runDoctor` for the
 * verification step.
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

function grantedPermissions(): Permissions {
  return {
    microphone: "granted",
    screen_recording: "granted",
    notifications: "granted",
    automation: {
      "com.apple.Safari": "granted",
      "com.google.Chrome": "granted",
    },
  };
}

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
    warmPermissions: async () => grantedPermissions(),
    installWatcher: async () => ({
      watchPlist: `/tmp/${MEETING_WATCH_PLIST_LABEL}.plist`,
      menubarPlist: `/tmp/${MEETING_MENUBAR_PLIST_LABEL}.plist`,
      systemAudioPersisted: false,
    }),
    ingest: async () => {},
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
        warmPermissions: async () => {
          order.push("warm-permissions");
          return grantedPermissions();
        },
        installWatcher: async () => {
          order.push("install-watcher");
          return {
            watchPlist: `/tmp/${MEETING_WATCH_PLIST_LABEL}.plist`,
            menubarPlist: `/tmp/${MEETING_MENUBAR_PLIST_LABEL}.plist`,
            systemAudioPersisted: false,
          };
        },
        ingest: async () => {
          order.push("ingest");
        },
        installAgentSkill: async () => {
          order.push("install-skill");
        },
      }),
    );
    // Order is the spec: ollama → model → permissions → watcher →
    // ingest → skill. The "install hourly sync agent" step that was
    // here in Phase 1–4 is GONE; the watcher's targeted ingest plus
    // ensureFresh() replace it.
    expect(order).toEqual([
      "start-ollama",
      "pull-model",
      "warm-permissions",
      "install-watcher",
      "ingest",
      "install-skill",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.startedOllama).toBe(true);
    expect(r.pulledModel).toBe(true);
    expect(r.warmedPermissions).toBe(true);
    expect(r.installedWatcher).toBe(true);
    expect(r.ingested).toBe(true);
    expect(r.installedSkill).toBe(true);
  });

  test("no-op-friendly: nothing executes when everything is already in good shape", async () => {
    let startCalls = 0;
    let pullCalls = 0;
    let permCalls = 0;
    let watcherCalls = 0;
    let skillCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        startOllama: async () => {
          startCalls++;
        },
        pullModel: async () => {
          pullCalls++;
        },
        warmPermissions: async () => {
          permCalls++;
          return grantedPermissions();
        },
        installWatcher: async () => {
          watcherCalls++;
          return {
            watchPlist: `/tmp/${MEETING_WATCH_PLIST_LABEL}.plist`,
            menubarPlist: `/tmp/${MEETING_MENUBAR_PLIST_LABEL}.plist`,
            systemAudioPersisted: false,
          };
        },
        installAgentSkill: async () => {
          skillCalls++;
        },
      }),
    );
    expect(startCalls).toBe(0);
    expect(pullCalls).toBe(0);
    // Permissions, watcher, skill always run (they're idempotent
    // themselves). The *bootstrap* doesn't need to know whether they
    // were already in place because their internal install logic
    // handles that.
    expect(permCalls).toBe(1);
    expect(watcherCalls).toBe(1);
    expect(skillCalls).toBe(1);
    expect(r.startedOllama).toBe(false);
    expect(r.pulledModel).toBe(false);
    expect(r.warmedPermissions).toBe(true);
    expect(r.installedWatcher).toBe(true);
    expect(r.ingested).toBe(true);
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

  test("permissions warm-up failure does not abort the bootstrap", async () => {
    // The Swift helper might be missing on a dev install or hit a
    // permission-system glitch. Don't take down the whole bootstrap.
    let watcherRan = false;
    const r = await runBootstrap(
      withDefaults({
        warmPermissions: async () => {
          throw new Error("swrag-helper missing");
        },
        installWatcher: async () => {
          watcherRan = true;
          return {
            watchPlist: `/tmp/${MEETING_WATCH_PLIST_LABEL}.plist`,
            menubarPlist: `/tmp/${MEETING_MENUBAR_PLIST_LABEL}.plist`,
            systemAudioPersisted: false,
          };
        },
      }),
    );
    expect(r.warmedPermissions).toBe(false);
    expect(watcherRan).toBe(true);
    expect(r.installedWatcher).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("watcher install failure does not abort the bootstrap", async () => {
    // The watcher install step is best-effort because dev runs
    // (`bun run`) don't have a stable binary path to embed in the
    // plist. A failure there shouldn't take down the whole
    // bootstrap.
    let skillRan = false;
    const r = await runBootstrap(
      withDefaults({
        installWatcher: async () => {
          throw new Error("no stable bin path (dev mode)");
        },
        installAgentSkill: async () => {
          skillRan = true;
        },
      }),
    );
    expect(r.installedWatcher).toBe(false);
    expect(skillRan).toBe(true);
    expect(r.installedSkill).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("skipPermissions / skipWatcher / skipSkill flags do what they say", async () => {
    let permCalls = 0;
    let watcherCalls = 0;
    let skillCalls = 0;
    const r = await runBootstrap(
      withDefaults({
        skipPermissions: true,
        skipWatcher: true,
        skipSkill: true,
        warmPermissions: async () => {
          permCalls++;
          return grantedPermissions();
        },
        installWatcher: async () => {
          watcherCalls++;
          return {
            watchPlist: `/tmp/${MEETING_WATCH_PLIST_LABEL}.plist`,
            menubarPlist: `/tmp/${MEETING_MENUBAR_PLIST_LABEL}.plist`,
            systemAudioPersisted: false,
          };
        },
        installAgentSkill: async () => {
          skillCalls++;
        },
      }),
    );
    expect(permCalls).toBe(0);
    expect(watcherCalls).toBe(0);
    expect(skillCalls).toBe(0);
    expect(r.warmedPermissions).toBe(false);
    expect(r.installedWatcher).toBe(false);
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
