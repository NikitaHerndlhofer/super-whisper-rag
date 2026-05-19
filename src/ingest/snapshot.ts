import { unlinkSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verbose, warn } from "../log.ts";
import { findSqlite3Binary } from "../sqlite3.ts";

/**
 * Make a read-only point-in-time copy of the Super Whisper SQLite DB.
 *
 * Super Whisper opens its database in journal_mode=delete and writes
 * intermittently. To avoid locking and to read a consistent snapshot, we
 * either run `sqlite3 source ".backup dest"` (preferred), or fall back to a
 * raw file copy. The returned path is in tmpdir and the caller must dispose.
 */
export interface Snapshot {
  path: string;
  dispose(): void;
}

export function snapshotSourceDb(sourcePath: string): Snapshot {
  if (!existsSync(sourcePath)) {
    throw new Error(`source DB not found: ${sourcePath}`);
  }
  const dest = join(tmpdir(), `swrag-snap-${process.pid}-${Date.now()}.sqlite`);
  const ok = trySqlite3Backup(sourcePath, dest);
  if (!ok) {
    verbose("sqlite3 .backup unavailable; falling back to file copy");
    fileCopyWithRetry(sourcePath, dest);
  }
  return {
    path: dest,
    dispose: () => {
      try {
        if (existsSync(dest)) unlinkSync(dest);
        const wal = `${dest}-wal`;
        const shm = `${dest}-shm`;
        if (existsSync(wal)) unlinkSync(wal);
        if (existsSync(shm)) unlinkSync(shm);
      } catch (e) {
        warn(
          `failed to dispose snapshot ${dest}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

function trySqlite3Backup(source: string, dest: string): boolean {
  let bin: string;
  try {
    // Use the same Homebrew sqlite3 the rest of the codebase relies on,
    // not whatever happens to be on PATH. `.backup` works in any build
    // (loadable extensions are not required for this dot-command), but
    // we want a single, predictable binary.
    bin = findSqlite3Binary();
  } catch {
    return false;
  }
  const r = Bun.spawnSync({
    cmd: [bin, source, `.backup '${dest}'`],
    timeout: 30_000,
  });
  if (r.exitCode !== 0) {
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    verbose(`sqlite3 .backup failed (${r.exitCode}): ${stderr}`);
    return false;
  }
  return existsSync(dest);
}

function fileCopyWithRetry(source: string, dest: string, retries = 5): void {
  let lastErr: unknown = null;
  for (let i = 0; i < retries; i++) {
    try {
      copyFileSync(source, dest);
      return;
    } catch (e) {
      lastErr = e;
      Bun.sleepSync(50 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
