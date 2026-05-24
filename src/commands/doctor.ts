import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { ensureExtensionCapableSqlite } from "../archive/open.ts";
import { LATEST_DATA_VERSION } from "../archive/updaters.ts";
import { vecDylibPath } from "../archive/vec-loader.ts";
import { checkOllama } from "../embed/ollama.ts";
import {
  MEETING_MENUBAR_PLIST_LABEL,
  MEETING_WATCH_PLIST_LABEL,
} from "../launchd/plist.ts";
import { getPermissions, type Permissions } from "../mac/helper.ts";
import { run } from "../spawn.ts";
import { findSqlite3Binary } from "../sqlite3.ts";

const VecVersionRowSchema = z.object({ v: z.string() });

export interface DoctorOptions {
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
  /** Override `launchctl list` for tests. */
  listLaunchAgents?: () => Promise<{ watch: boolean; menubar: boolean }>;
  /** Override the permissions probe for tests. */
  checkPermissions?: () => Promise<Permissions | null>;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

/**
 * Environment health check. Verifies every piece swrag depends on at
 * runtime, plus the meeting-watcher launch agents and macOS
 * permissions the watcher needs.
 *
 * The source DB and archive are intentionally not checked here —
 * `swrag index` will surface a clear error if either is missing.
 */
export async function runDoctor(opts: DoctorOptions): Promise<{
  exitCode: number;
  output: string;
}> {
  const checks: Check[] = [];

  // 1. Extension-capable SQLite (binary + bun:sqlite dylib swap).
  //    macOS ships sqlite3 without loadable-extension support; we
  //    require Homebrew's. Both the CLI shell-out and bun:sqlite need
  //    the same dylib.
  let sqliteOk = true;
  let sqliteDetail: string;
  try {
    const cli = findSqlite3Binary();
    const dylib = ensureExtensionCapableSqlite();
    if (dylib.dylib == null) {
      sqliteOk = false;
      sqliteDetail = `${cli} (bun:sqlite is on stock SQLite — extensions disabled)`;
    } else {
      sqliteDetail = `${cli} + ${dylib.dylib}`;
    }
  } catch (e) {
    sqliteOk = false;
    sqliteDetail = e instanceof Error ? e.message : String(e);
  }
  checks.push({
    name: "sqlite3 (extension-capable)",
    ok: sqliteOk,
    detail: sqliteDetail,
    hint: sqliteOk ? undefined : "brew install sqlite",
  });

  // 2. sqlite-vec
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

  // 3. Ollama
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

  // 4. Archive + data version + chunk coverage
  if (existsSync(opts.archive)) {
    checks.push({
      name: "archive present",
      ok: true,
      detail: opts.archive,
    });
    checks.push(dataVersionCheck(opts.archive));
    checks.push(chunkCoverageCheck(opts.archive));
  }

  // 5. Meeting watcher launchd agents
  const listAgents = opts.listLaunchAgents ?? listMeetingLaunchAgents;
  try {
    const status = await listAgents();
    const both = status.watch && status.menubar;
    const detail = `watch=${status.watch ? "loaded" : "missing"}, menubar=${status.menubar ? "loaded" : "missing"}`;
    checks.push({
      name: "meeting watcher (launchd)",
      ok: both,
      detail,
      hint: both ? undefined : "swrag meeting enable-watcher",
    });
  } catch (e) {
    checks.push({
      name: "meeting watcher (launchd)",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      hint: "swrag meeting enable-watcher",
    });
  }

  // 6. macOS permissions (mic + screen recording + Apple Events)
  const checkPerms = opts.checkPermissions ?? defaultCheckPermissions;
  const perms = await checkPerms();
  checks.push(buildPermissionsCheck(perms));

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
 * Probe launchctl for the two meeting-watcher labels. Uses
 * `launchctl print` because `launchctl list` requires the legacy
 * unprivileged domain which is flaky on modern macOS; `print
 * gui/<uid>/<label>` exits 0 iff the agent is loaded for the current
 * GUI session.
 */
async function listMeetingLaunchAgents(): Promise<{ watch: boolean; menubar: boolean }> {
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error("cannot determine current uid for launchctl probe");
  }
  const probe = (label: string): boolean => {
    const r = run(["launchctl", "print", `gui/${uid}/${label}`], { timeoutMs: 3_000 });
    return r.exitCode === 0;
  };
  return {
    watch: probe(MEETING_WATCH_PLIST_LABEL),
    menubar: probe(MEETING_MENUBAR_PLIST_LABEL),
  };
}

async function defaultCheckPermissions(): Promise<Permissions | null> {
  try {
    return await getPermissions({ prompt: false });
  } catch {
    // Swift helper missing or failed — treat as soft fail. The check
    // is informational; we surface the error in the detail.
    return null;
  }
}

const PERM_LABELS = {
  granted: "granted",
  denied: "DENIED",
  not_determined: "not_determined",
  provisional: "provisional",
} as const;

function buildPermissionsCheck(perms: Permissions | null): Check {
  const name = "macOS permissions (mic + screen + automation + notifications)";
  if (perms == null) {
    return {
      name,
      ok: false,
      detail: "permissions probe failed (swrag-helper missing or errored)",
      hint: "swrag meeting permissions-check --prompt",
    };
  }
  const mic = PERM_LABELS[perms.microphone];
  const screen = PERM_LABELS[perms.screen_recording];
  // Notifications: `provisional` is treated as "ok-ish" — it's
  // Apple's silent-opt-in mode where alerts go straight to
  // Notification Center without prompting. We still display the
  // status verbatim so the user knows where they're at.
  const notif = PERM_LABELS[perms.notifications];
  const automationEntries = Object.entries(perms.automation);
  const automationGranted = automationEntries.filter(([, v]) => v === "granted").length;
  const automationDenied = automationEntries
    .filter(([, v]) => v === "denied")
    .map(([k]) => k);
  const automationDetail =
    automationEntries.length === 0
      ? "automation=(none)"
      : automationDenied.length > 0
        ? `automation=${automationGranted}/${automationEntries.length} granted (denied: ${automationDenied.join(", ")})`
        : `automation=${automationGranted}/${automationEntries.length} granted`;
  const detail = `mic=${mic}, screen=${screen}, notifications=${notif}, ${automationDetail}`;
  const anyDenied =
    perms.microphone === "denied" ||
    perms.screen_recording === "denied" ||
    perms.notifications === "denied" ||
    automationDenied.length > 0;
  // Treat `not_determined` as soft-fail: the user hasn't been
  // prompted yet; the watcher will prompt on first use. We surface
  // it so the user knows they can warm them eagerly. `provisional`
  // is the OS's silent-opt-in mode and doesn't need a prompt.
  const anyUndecided =
    perms.microphone === "not_determined" ||
    perms.screen_recording === "not_determined" ||
    perms.notifications === "not_determined" ||
    automationEntries.some(([, v]) => v === "not_determined");
  const ok = !anyDenied && !anyUndecided;
  return {
    name,
    ok,
    detail,
    hint: ok
      ? undefined
      : anyDenied
        ? "Grant the denied permissions in System Settings → Privacy & Security"
        : "swrag meeting permissions-check --prompt",
  };
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
 *     `swrag index` (which the meeting watcher's processor triggers
 *     after each completion, plus on demand via the `ensureFresh()`
 *     hook on every `swrag sql`). The check tells the user what's
 *     coming; it doesn't try to repair anything itself.
 *
 * Either way, the fix is automatic — no manual intervention required.
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
