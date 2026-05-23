/**
 * `enable-watcher` atomic install tests.
 *
 * We never touch real launchd in tests — the `install` /
 * `uninstall` dependencies are stubbed. Coverage:
 *
 *   - Both plists succeed → both returned paths, system_audio
 *     config persisted iff the flag was set.
 *   - Second install fails → first is rolled back via `uninstall`
 *     before the function throws.
 *   - `disable-watcher` is robust to partial state (one half
 *     missing).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, openArchive } from "../../src/archive/open.ts";
import {
  disableWatcher,
  enableWatcher,
} from "../../src/commands/enable-watcher.ts";
import {
  CONFIG_SYSTEM_AUDIO_ACK,
  CONFIG_SYSTEM_AUDIO_DEFAULT,
} from "../../src/meeting/daemon.ts";
import {
  MEETING_MENUBAR_PLIST_LABEL,
  MEETING_WATCH_PLIST_LABEL,
} from "../../src/launchd/plist.ts";

let workDir: string;
let archive: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-watcher-"));
  archive = join(workDir, "archive.sqlite");
  // Initialise the archive so the system-audio config writes have
  // schema to land on.
  const db = openArchive(archive, {});
  db.close();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("enableWatcher", () => {
  test("happy path: both plists installed, no system_audio config touched", async () => {
    const installed: string[] = [];
    const r = await enableWatcher({
      binPath: "/opt/homebrew/bin/swrag",
      archive,
      install: async ({ label }) => {
        installed.push(label);
        return `/tmp/${label}.plist`;
      },
    });
    expect(installed).toEqual([MEETING_WATCH_PLIST_LABEL, MEETING_MENUBAR_PLIST_LABEL]);
    expect(r.watchPlist).toBe(`/tmp/${MEETING_WATCH_PLIST_LABEL}.plist`);
    expect(r.menubarPlist).toBe(`/tmp/${MEETING_MENUBAR_PLIST_LABEL}.plist`);
    expect(r.systemAudioPersisted).toBe(false);
    const db = openArchive(archive, {});
    try {
      expect(getConfig(db, CONFIG_SYSTEM_AUDIO_ACK)).toBeUndefined();
      expect(getConfig(db, CONFIG_SYSTEM_AUDIO_DEFAULT)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("--system-audio: persists both default + ack in config", async () => {
    const r = await enableWatcher({
      binPath: "/opt/homebrew/bin/swrag",
      archive,
      systemAudio: true,
      install: async ({ label }) => `/tmp/${label}.plist`,
    });
    expect(r.systemAudioPersisted).toBe(true);
    const db = openArchive(archive, {});
    try {
      expect(getConfig(db, CONFIG_SYSTEM_AUDIO_DEFAULT)).toBe("1");
      expect(getConfig(db, CONFIG_SYSTEM_AUDIO_ACK)).toBe("1");
    } finally {
      db.close();
    }
  });

  test("atomic rollback: second install fails → first is uninstalled, error surfaces", async () => {
    const installed: string[] = [];
    const uninstalled: string[] = [];
    let caught: Error | null = null;
    try {
      await enableWatcher({
        binPath: "/opt/homebrew/bin/swrag",
        archive,
        install: async ({ label }) => {
          if (label === MEETING_WATCH_PLIST_LABEL) {
            installed.push(label);
            return `/tmp/${label}.plist`;
          }
          throw new Error("simulated bootstrap failure");
        },
        uninstall: async ({ label }) => {
          uninstalled.push(label);
          return true;
        },
      });
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(caught?.message ?? "").toContain("rolled back");
    expect(installed).toEqual([MEETING_WATCH_PLIST_LABEL]);
    expect(uninstalled).toEqual([MEETING_WATCH_PLIST_LABEL]);
  });

  test("rollback failure is logged but the original error still surfaces", async () => {
    let caught: Error | null = null;
    try {
      await enableWatcher({
        binPath: "/opt/homebrew/bin/swrag",
        archive,
        install: async ({ label }) => {
          if (label === MEETING_WATCH_PLIST_LABEL) return `/tmp/${label}.plist`;
          throw new Error("menubar bootstrap failed");
        },
        uninstall: async () => {
          throw new Error("rollback also failed");
        },
      });
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    // The user-facing error is still the install failure, not the
    // rollback failure.
    expect(caught?.message ?? "").toContain("menubar bootstrap failed");
  });

  test("first install failure: no rollback attempted (nothing to roll back)", async () => {
    const uninstalled: string[] = [];
    let caught: Error | null = null;
    try {
      await enableWatcher({
        binPath: "/opt/homebrew/bin/swrag",
        archive,
        install: async () => {
          throw new Error("watch bootstrap failed");
        },
        uninstall: async ({ label }) => {
          uninstalled.push(label);
          return true;
        },
      });
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(uninstalled).toEqual([]);
  });
});

describe("disableWatcher", () => {
  test("both removed: result reports each half", async () => {
    const seen: string[] = [];
    const r = await disableWatcher({
      uninstall: async ({ label }) => {
        seen.push(label);
        return true;
      },
    });
    expect(r.watchRemoved).toBe(true);
    expect(r.menubarRemoved).toBe(true);
    expect(seen).toEqual([MEETING_WATCH_PLIST_LABEL, MEETING_MENUBAR_PLIST_LABEL]);
  });

  test("partial state: watch missing, menubar present → mixed result", async () => {
    const r = await disableWatcher({
      uninstall: async ({ label }) => label === MEETING_MENUBAR_PLIST_LABEL,
    });
    expect(r.watchRemoved).toBe(false);
    expect(r.menubarRemoved).toBe(true);
  });

  test("uninstall throwing on one half doesn't block the other", async () => {
    const r = await disableWatcher({
      uninstall: async ({ label }) => {
        if (label === MEETING_WATCH_PLIST_LABEL) throw new Error("simulated bootout failure");
        return true;
      },
    });
    expect(r.watchRemoved).toBe(false);
    expect(r.menubarRemoved).toBe(true);
  });
});
