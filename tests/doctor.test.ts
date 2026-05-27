/**
 * Phase 5 `swrag doctor` checks.
 *
 * `runDoctor` does a lot of real-world I/O — sqlite3, vec, Ollama,
 * launchctl, the Swift permissions helper. We can't reasonably stub
 * all of it inside `runDoctor` itself, so this file focuses on the
 * two Phase-5-added checks (`listLaunchAgents` and
 * `checkPermissions`) where the dependency-injection seams already
 * exist. The other checks (sqlite, vec, Ollama, archive, data
 * version, chunk coverage) are covered by their respective module
 * tests.
 */
import { describe, expect, test } from "bun:test";
import { runDoctor } from "../src/commands/doctor.ts";
import type { Permissions } from "../src/mac/helper.ts";

const baseOpts = {
  sourceDb: "/tmp/swrag-doctor-test-nope.sqlite",
  archive: "/tmp/swrag-doctor-test-no-archive.sqlite",
  embedModel: "test-model",
  ollamaHost: "http://127.0.0.1:0",
};

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

// v0.9.12 added a helper-signature check. We stub it across every
// doctor test so tests don't depend on whether the bundle is
// materialised on the host (it usually is locally, but isn't in CI).
const stubSig = () => null;

describe("runDoctor — meeting watcher (launchd)", () => {
  test("reports loaded when both labels are present", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => grantedPermissions(),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("meeting watcher (launchd)");
    expect(r.output).toMatch(/watch=loaded.*menubar=loaded/);
    expect(r.output).not.toContain("hint: swrag meeting enable-watcher");
  });

  test("reports missing + offers enable-watcher hint when either is absent", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: false, menubar: true }),
      checkPermissions: async () => grantedPermissions(),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("watch=missing");
    expect(r.output).toContain("hint: swrag meeting enable-watcher");
    expect(r.exitCode).not.toBe(0);
  });

  test("launchctl probe throwing is treated as a soft fail with the same hint", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => {
        throw new Error("launchctl missing");
      },
      checkPermissions: async () => grantedPermissions(),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("meeting watcher (launchd)");
    expect(r.output).toContain("launchctl missing");
    expect(r.output).toContain("hint: swrag meeting enable-watcher");
  });
});

describe("runDoctor — macOS permissions", () => {
  test("all granted: passes; no hint", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => grantedPermissions(),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("macOS permissions");
    expect(r.output).toContain("mic=granted");
    expect(r.output).toContain("screen=granted");
    expect(r.output).toContain("automation=2/2 granted");
  });

  test("denied entries surface the offending bundle ids and the system-settings hint", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => ({
        microphone: "granted",
        screen_recording: "denied",
        notifications: "granted",
        automation: {
          "com.apple.Safari": "granted",
          "com.google.Chrome": "denied",
        },
      }),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("screen=DENIED");
    expect(r.output).toContain("denied: com.google.Chrome");
    expect(r.output).toContain("hint: Grant the denied permissions in System Settings");
    expect(r.exitCode).not.toBe(0);
  });

  test("not_determined entries are soft-failed with the `--prompt` hint", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => ({
        microphone: "not_determined",
        screen_recording: "granted",
        notifications: "granted",
        automation: {},
      }),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("mic=not_determined");
    expect(r.output).toContain("hint: swrag meeting permissions-check --prompt");
    expect(r.exitCode).not.toBe(0);
  });

  test("notifications=denied is reported and triggers the system-settings hint", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => ({
        microphone: "granted",
        screen_recording: "granted",
        notifications: "denied",
        automation: {},
      }),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("notifications=DENIED");
    expect(r.output).toContain("hint: Grant the denied permissions in System Settings");
    expect(r.exitCode).not.toBe(0);
  });

  test("notifications=provisional is surfaced verbatim and treated as ok", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => ({
        microphone: "granted",
        screen_recording: "granted",
        notifications: "provisional",
        automation: { "com.apple.Safari": "granted" },
      }),
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("notifications=provisional");
  });

  test("probe returning null is surfaced as a clear error", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => null,
      checkHelperSignature: stubSig,
    });
    expect(r.output).toContain("permissions probe failed");
    expect(r.output).toContain("hint: swrag meeting permissions-check --prompt");
    expect(r.exitCode).not.toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* v0.9.12 — helper signature check                                           */
/* -------------------------------------------------------------------------- */

describe("runDoctor — helper signature (v0.9.12)", () => {
  test("ad-hoc: reports the hint to run setup-signing, ok=true (mic-only is fine)", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => grantedPermissions(),
      checkHelperSignature: () => "ad-hoc",
    });
    expect(r.output).toContain("helper signature");
    expect(r.output).toContain("helper signed by: ad-hoc");
    expect(r.output).toContain("swrag setup-signing");
  });

  test("Apple Development cert: reports the team id, no hint", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => grantedPermissions(),
      checkHelperSignature: () =>
        "Apple Development: Jane Dev (Team TEAMID12AB)",
    });
    expect(r.output).toContain("helper signature");
    expect(r.output).toContain(
      "helper signed by: Apple Development: Jane Dev (Team TEAMID12AB)",
    );
    expect(r.output).not.toContain("swrag setup-signing");
  });

  test("bundle not yet materialised: reports the deferred-materialisation note, ok=true", async () => {
    const r = await runDoctor({
      ...baseOpts,
      listLaunchAgents: async () => ({ watch: true, menubar: true }),
      checkPermissions: async () => grantedPermissions(),
      checkHelperSignature: () => null,
    });
    expect(r.output).toContain("helper signature");
    expect(r.output).toContain("not yet materialised");
  });
});
