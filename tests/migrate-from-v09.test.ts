import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFromV09 } from "../src/commands/migrate-from-v09.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swrag-mig-v09-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePlist(label: string): string {
  const p = join(dir, `${label}.plist`);
  writeFileSync(p, "<?xml ?>", "utf8");
  return p;
}

describe("migrateFromV09", () => {
  test("removes all three legacy plists when present", async () => {
    const a = writePlist("com.superwhisper-rag.meeting-watch");
    const b = writePlist("com.superwhisper-rag.meeting-menubar");
    const c = writePlist("com.superwhisper-rag.sync");
    const calls: string[] = [];
    const removed = await migrateFromV09({
      launchAgentsDir: dir,
      bootout: (label) => {
        calls.push(label);
      },
    });
    expect(removed.sort()).toEqual([a, b, c].sort());
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(false);
    // bootout was attempted for each removed plist.
    expect(calls.sort()).toEqual([
      "com.superwhisper-rag.meeting-menubar",
      "com.superwhisper-rag.meeting-watch",
      "com.superwhisper-rag.sync",
    ]);
  });

  test("no-op when nothing exists", async () => {
    const calls: string[] = [];
    const removed = await migrateFromV09({
      launchAgentsDir: dir,
      bootout: (label) => {
        calls.push(label);
      },
    });
    expect(removed).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("idempotent — re-run after first run is a no-op", async () => {
    writePlist("com.superwhisper-rag.meeting-watch");
    const calls: string[] = [];
    const removed1 = await migrateFromV09({
      launchAgentsDir: dir,
      bootout: (label) => {
        calls.push(label);
      },
    });
    expect(removed1).toHaveLength(1);
    const removed2 = await migrateFromV09({
      launchAgentsDir: dir,
      bootout: (label) => {
        calls.push(label);
      },
    });
    expect(removed2).toEqual([]);
    expect(calls).toEqual(["com.superwhisper-rag.meeting-watch"]);
  });

  test("bootout failures are tolerated; plist is still removed", async () => {
    const p = writePlist("com.superwhisper-rag.meeting-watch");
    const removed = await migrateFromV09({
      launchAgentsDir: dir,
      bootout: () => {
        throw new Error("launchctl exploded");
      },
    });
    expect(removed).toEqual([p]);
    expect(existsSync(p)).toBe(false);
  });
});
