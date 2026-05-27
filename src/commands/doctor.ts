import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { ensureExtensionCapableSqlite } from "../archive/open.ts";
import { LATEST_DATA_VERSION } from "../archive/updaters.ts";
import { vecDylibPath } from "../archive/vec-loader.ts";
import { checkOllama } from "../embed/ollama.ts";
import { PLIST_LABEL } from "../launchd/plist.ts";
import { run } from "../spawn.ts";
import { findSqlite3Binary } from "../sqlite3.ts";

const VecVersionRowSchema = z.object({ v: z.string() });

export interface DoctorOptions {
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
  /**
   * Override the watch-agent probe for tests. Returns true iff
   * `launchctl print gui/<uid>/<label>` reports the agent is loaded.
   */
  probeWatchAgent?: () => boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

/**
 * Minimal environment check. Verifies the three pieces we actually depend
 * on at runtime: a sqlite3 binary that supports loadable extensions, the
 * sqlite-vec extension, and Ollama with the requested model.
 *
 * The source DB and archive are intentionally not checked here — `swrag
 * index` will surface a clear error if either is missing.
 */
export async function runDoctor(opts: DoctorOptions): Promise<{
  exitCode: number;
  output: string;
}> {
  const checks: Check[] = [];

  const sqlite3 = safeCheck(
    "sqlite3 binary (extension-capable)",
    () => findSqlite3Binary(),
    "brew install sqlite",
  );
  checks.push(sqlite3);

  const dylib = ensureExtensionCapableSqlite();
  checks.push({
    name: "bun:sqlite custom build",
    ok: dylib.dylib != null,
    detail: dylib.dylib ?? "(using stock SQLite — extensions disabled)",
    hint: dylib.dylib ? undefined : "brew install sqlite",
  });

  let vecOk = false;
  let vecDetail = "";
  try {
    const db = new Database(":memory:");
    db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
    const raw: unknown = db.prepare("SELECT vec_version() AS v").get();
    vecDetail = `sqlite-vec ${VecVersionRowSchema.parse(raw).v}`;
    db.close();
    vecOk = true;
  } catch (e) {
    vecDetail = e instanceof Error ? e.message : String(e);
  }
  checks.push({
    name: "sqlite-vec loadable",
    ok: vecOk,
    detail: vecDetail,
  });

  const ollamaErr = await checkOllama({
    host: opts.ollamaHost,
    model: opts.embedModel,
  });
  checks.push({
    name: `Ollama at ${opts.ollamaHost}`,
    ok: ollamaErr == null,
    detail: ollamaErr ?? `${opts.embedModel} reachable`,
    hint:
      ollamaErr == null
        ? undefined
        : ollamaErr.includes("not pulled")
          ? `ollama pull ${opts.embedModel}`
          : "brew install ollama && brew services start ollama",
  });

  if (existsSync(opts.archive)) {
    checks.push({
      name: "archive present",
      ok: true,
      detail: opts.archive,
    });
    checks.push(dataVersionCheck(opts.archive));
    checks.push(chunkCoverageCheck(opts.archive));
  }

  checks.push(watchAgentCheck(opts.probeWatchAgent));

  const ok = checks.every((c) => c.ok);
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`  [${c.ok ? "ok  " : "FAIL"}] ${c.name} — ${c.detail}`);
    if (!c.ok && c.hint) lines.push(`         hint: ${c.hint}`);
  }
  lines.push("");
  lines.push(ok ? "All checks passed." : "One or more checks failed.");
  return { exitCode: ok ? 0 : 2, output: `${lines.join("\n")}\n` };
}

/**
 * Probe the watch launchd agent by asking `launchctl print` whether
 * the unit is loaded. Exit code 0 = loaded; any non-zero = not loaded
 * (most commonly "service not loaded" but we don't distinguish — the
 * fix is the same).
 *
 * We deliberately don't try to introspect the plist on disk. A plist
 * file present but not loaded is a stale install from before a
 * `launchctl bootout`; what the user cares about is "is my watcher
 * actually running right now", which only `launchctl print` can
 * answer.
 */
function watchAgentCheck(probe?: () => boolean): Check {
  const name = "watch agent (launchd)";
  const loaded = (probe ?? defaultProbeWatchAgent)();
  return {
    name,
    ok: loaded,
    detail: loaded ? `${PLIST_LABEL} loaded` : `${PLIST_LABEL} not loaded`,
    hint: loaded ? undefined : "swrag enable-watch",
  };
}

function defaultProbeWatchAgent(): boolean {
  const uid = process.getuid?.();
  if (uid == null) return false;
  const r = run(["launchctl", "print", `gui/${uid}/${PLIST_LABEL}`], { timeoutMs: 3_000 });
  return r.exitCode === 0;
}

function safeCheck(name: string, fn: () => string, hint: string): Check {
  try {
    return { name, ok: true, detail: fn() };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      hint,
    };
  }
}

const CoverageRowSchema = z.object({
  long_rows: z.number().int(),
  long_with_chunks: z.number().int(),
});

const DataVersionRowSchema = z.object({ value: z.string() });

/**
 * Report `data_version` against the binary's `LATEST_DATA_VERSION`.
 *
 * Both states are intentionally `ok = true`:
 *
 *   - Matching: archive is current.
 *   - Lagging or missing: a pending updater will run on the next
 *     `swrag index` (which the launchd agent triggers hourly). The
 *     check tells the user what's coming; it doesn't try to repair
 *     anything itself.
 *
 * The latter case is only an issue if the launchd agent is disabled,
 * in which case `swrag index` from the CLI catches up. Either way, the
 * fix is automatic — no manual intervention required.
 */
function dataVersionCheck(archivePath: string): Check {
  const name = "data version";
  try {
    const db = new Database(archivePath, { readonly: true });
    try {
      const raw: unknown = db
        .prepare("SELECT value FROM config WHERE key = 'data_version'")
        .get();
      const stored = raw == null ? null : DataVersionRowSchema.parse(raw).value;
      const storedNum = stored == null ? null : Number.parseInt(stored, 10);
      if (storedNum != null && Number.isFinite(storedNum) && storedNum === LATEST_DATA_VERSION) {
        return {
          name,
          ok: true,
          detail: `${storedNum} (matches binary)`,
        };
      }
      const storedLabel = stored ?? "missing";
      return {
        name,
        ok: true,
        detail: `${storedLabel} (binary expects ${LATEST_DATA_VERSION}; run swrag index to apply pending updaters)`,
      };
    } finally {
      db.close();
    }
  } catch (e) {
    return {
      name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Verify every long recording (word count above the chunk threshold,
 * canonical) has at least one row in `recording_chunk`. Catches the
 * scenarios where:
 *
 *   - The user is running a binary that knows about chunks but hasn't
 *     finished a backfill yet (long rows exist with no chunks).
 *   - An interrupted `swrag index` left some long rows un-chunked.
 *   - A `chunk_strategy` change wiped chunks but a follow-up sync
 *     hasn't repopulated them yet.
 *
 * The fix in every case is `swrag index`. This check is informational —
 * it points at the gap; it doesn't try to repair anything.
 */
function chunkCoverageCheck(archivePath: string): Check {
  const name = "chunk coverage (long rows)";
  try {
    const db = new Database(archivePath, { readonly: true });
    db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
    try {
      // Some archives may predate migration 004 (no `recording_chunk`
      // table). Detect that and degrade gracefully rather than erroring.
      const tableRaw: unknown = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'recording_chunk'",
        )
        .get();
      const hasChunkTable = z.object({ n: z.number() }).parse(tableRaw).n > 0;
      if (!hasChunkTable) {
        return {
          name,
          ok: true,
          detail: "schema predates chunking (run `swrag index` to upgrade)",
        };
      }
      // Threshold for "long" matches DEFAULT_CHUNK_STRATEGY.threshold.
      // We deliberately hard-code 500 here rather than import the
      // chunker module: this check should be runnable even if the user
      // tunes the chunker constants in the future without re-shipping
      // doctor — the only false-negative is a tightened threshold,
      // which would report "ok" instead of "needs reindex".
      const raw: unknown = db
        .prepare(
          `SELECT
             COUNT(*) AS long_rows,
             SUM(CASE WHEN EXISTS (
               SELECT 1 FROM recording_chunk c WHERE c.folder_name = r.folder_name
             ) THEN 1 ELSE 0 END) AS long_with_chunks
           FROM recording r
           WHERE COALESCE(r.llm_word_count, r.raw_word_count) > 500
             AND r.superseded_by IS NULL`,
        )
        .get();
      const cov = CoverageRowSchema.parse(raw);
      const missing = cov.long_rows - cov.long_with_chunks;
      const ok = missing === 0;
      return {
        name,
        ok,
        detail: ok
          ? `${cov.long_with_chunks}/${cov.long_rows} long rows chunked`
          : `${missing} long row(s) missing chunks (${cov.long_with_chunks}/${cov.long_rows} chunked)`,
        hint: ok ? undefined : "swrag index",
      };
    } finally {
      db.close();
    }
  } catch (e) {
    return {
      name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
