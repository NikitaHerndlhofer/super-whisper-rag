import { unlinkSync, existsSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verbose, warn } from "../log.ts";
import { run } from "../spawn.ts";
import { findSqlite3Binary } from "../sqlite3.ts";

const SNAPSHOT_PREFIX = "swrag-snap-";
const SNAPSHOT_STALE_MS = 60 * 60 * 1000;

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
  sweepStaleSnapshots();
  const dest = join(tmpdir(), `${SNAPSHOT_PREFIX}${process.pid}-${Date.now()}.sqlite`);
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
        warn(`failed to dispose snapshot ${dest}: ${e instanceof Error ? e.message : String(e)}`);
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
  const r = run([bin, source, `.backup '${dest}'`], { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    verbose(`sqlite3 .backup failed (${r.exitCode}): ${r.stderr}`);
    return false;
  }
  return existsSync(dest);
}

/**
 * Best-effort cleanup of snapshot files left behind by previous runs that
 * crashed before `dispose()` could fire (e.g. SIGKILL, kernel panic).
 * macOS doesn't aggressively sweep /var/folders/.../T on its own, so
 * these would otherwise accumulate.
 *
 * Conservative: only delete entries that match our prefix AND haven't
 * been touched in the last hour. Anything younger could belong to a
 * concurrent `swrag` invocation.
 */
function sweepStaleSnapshots(): void {
  const dir = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SNAPSHOT_STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    const full = join(dir, name);
    try {
      const s = statSync(full);
      if (s.mtimeMs >= cutoff) continue;
      unlinkSync(full);
      verbose(`swept stale snapshot ${full}`);
    } catch {
      // Permissions / race with another swrag — ignore.
    }
  }
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
