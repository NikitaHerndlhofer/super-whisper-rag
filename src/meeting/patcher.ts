/**
 * Super Whisper metadata patcher.
 *
 * The ONLY place in this codebase that writes to Super Whisper's own
 * SQLite. Every other meeting-pipeline module reads SW state read-only
 * (sources.ts, sw-control.ts). Concentrating writes here gives us a
 * single audit surface for the "patched SW DB" coupling.
 *
 * Empirical findings driving this design come from
 * `docs/sw-patcher-spike.md`:
 *
 *   - SW writes its row immediately on `open -a superwhisper`, but for
 *     modes with an LLM cleanup step (Universal, Meeting, …) SW
 *     rewrites the row — including `datetime` — after the LLM step
 *     completes (~10 s after the ASR step). This patcher must therefore
 *     only run after `waitForCompletion`'s quiescence-based gate.
 *   - `SQLITE_BUSY` was never observed across 21 probes; we set
 *     `PRAGMA busy_timeout = 5000` defensively but do NOT wrap the
 *     UPDATE in SAVEPOINT-retry logic. Add it back if a future spike
 *     re-run sees BUSY against a new SW build.
 *   - `recording` table schema is captured in `TESTED_SW_SCHEMA`; we
 *     compare via `PRAGMA table_info` once per processor lifetime and
 *     throw a clear error pointing at the spike doc if SW has drifted.
 *   - `appVersion` is compared to `TESTED_SW_VERSIONS`; mismatch warns
 *     but does not block. The patch operation has been mechanically
 *     stable across the 2.13 → 2.14 range.
 */
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { verbose, warn } from "../log.ts";

/**
 * Defensive post-patch re-verify. Even with the quiescence gate, SW
 * could theoretically rewrite `datetime` after we patch (e.g. a slow
 * background flush, a delayed LLM step on a future SW build). After
 * the immediate verify succeeds we sleep this long, re-read both DB
 * and meta.json, and if they got clobbered we re-apply up to
 * `POST_PATCH_MAX_ATTEMPTS` times before throwing.
 */
const POST_PATCH_RECHECK_MS = 5_000;
const POST_PATCH_MAX_ATTEMPTS = 3;

/**
 * SW versions this patcher has been validated against. Outside this
 * list we `warn()` and continue — the patch path is mechanical
 * (single UPDATE + meta.json atomic rewrite) and has not regressed
 * across 2.13.x → 2.14.x. Re-verify before bumping.
 */
export const TESTED_SW_VERSIONS = ["2.13.2", "2.14.0"] as const;

/**
 * The 19 columns observed on SW 2.14.0's `recording` table. We
 * compare names + types case-insensitively. SQLite reports the type
 * affinity exactly as declared in the CREATE TABLE.
 *
 * If a future SW upgrade adds, drops, or renames a column, this
 * constant fails fast — re-run the spike, update the constant, and
 * re-test the patch path.
 *
 * See `docs/sw-patcher-spike.md` §1.
 */
export const TESTED_SW_SCHEMA: readonly (readonly [string, string])[] = [
  ["id", "TEXT"],
  ["datetime", "DATETIME"],
  ["duration", "DOUBLE"],
  ["appVersion", "TEXT"],
  ["modelKey", "TEXT"],
  ["modelName", "TEXT"],
  ["languageModelName", "TEXT"],
  ["recordingDevice", "TEXT"],
  ["rawWordCount", "INTEGER"],
  ["llmWordCount", "INTEGER"],
  ["prompt", "TEXT"],
  ["processingTime", "INTEGER"],
  ["languageModelProcessingTime", "INTEGER"],
  ["modeName", "TEXT"],
  ["promptContext", "TEXT"],
  ["folderName", "TEXT"],
  ["fromFile", "BOOLEAN"],
  ["createdAt", "DATETIME"],
  ["languageModelKey", "TEXT"],
] as const;

const TableInfoRowSchema = z.object({
  name: z.string(),
  type: z.string(),
});

const AppVersionRowSchema = z.object({ appVersion: z.string().nullable() });
const DatetimeRowSchema = z.object({ datetime: z.string() });

export interface PatcherOptions {
  /** Path to Super Whisper's SQLite. */
  swDbPath: string;
  /** Path to SW's `recordings` directory; the parent of all folderName dirs. */
  swRecordingsDir: string;
  /**
   * Skip the schema validation step. Used by tests that build their own
   * SW-shaped fixture DB without every column — production callers
   * leave this `false`.
   */
  skipSchemaValidation?: boolean;
  /**
   * Override the post-patch re-verify window (default 5 000 ms). Tests
   * use a small value to keep the suite fast; production code leaves
   * this undefined.
   */
  postPatchRecheckMs?: number;
  /**
   * Override the post-patch retry budget (default 3). Tests with a
   * synthetic clobbering harness use this to bound attempts.
   */
  postPatchMaxAttempts?: number;
}

export interface PatchResult {
  folderName: string;
  capturedAt: string;
  /** SW's `appVersion` value for the patched row, for logging. */
  swAppVersion: string | null;
  /** True if `swAppVersion` was outside `TESTED_SW_VERSIONS`. */
  versionWarned: boolean;
  /**
   * How many UPDATE attempts it took for the patch to stick across the
   * post-patch re-verify window. 1 means the first patch was durable
   * (the common case under the quiescence-based completion gate).
   */
  attempts: number;
}

/**
 * Patcher owns one read/write handle on SW's SQLite for its entire
 * lifetime. The processor constructs one per run; `close()` is called
 * when the run ends.
 */
export class SwPatcher {
  private readonly db: Database;
  private readonly recordingsDir: string;
  private readonly swDbPath: string;
  private readonly postPatchRecheckMs: number;
  private readonly postPatchMaxAttempts: number;
  private schemaValidated: boolean;

  constructor(opts: PatcherOptions) {
    if (!existsSync(opts.swDbPath)) {
      throw new Error(`SW DB not found: ${opts.swDbPath}`);
    }
    this.swDbPath = opts.swDbPath;
    this.recordingsDir = opts.swRecordingsDir;
    this.db = new Database(opts.swDbPath, { readwrite: true });
    // Even though the spike found zero BUSY events, set a defensive
    // timeout. SQLite returns the new value as a single row; bun:sqlite
    // tolerates that fine via `exec`.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.schemaValidated = opts.skipSchemaValidation === true;
    this.postPatchRecheckMs = opts.postPatchRecheckMs ?? POST_PATCH_RECHECK_MS;
    this.postPatchMaxAttempts = opts.postPatchMaxAttempts ?? POST_PATCH_MAX_ATTEMPTS;
  }

  /** Visible to tests. */
  get database(): Database {
    return this.db;
  }

  /**
   * Validate SW's `recording` schema against `TESTED_SW_SCHEMA`. Throws
   * with a clear error pointing at the spike doc if anything has
   * drifted. Run lazily on first patch — never more than once per
   * patcher lifetime.
   */
  validateSchema(): void {
    if (this.schemaValidated) return;
    const raw: unknown[] = this.db.prepare("PRAGMA table_info(recording)").all();
    if (raw.length === 0) {
      throw new Error(
        `SW DB at ${this.swDbPath} has no \`recording\` table. ` +
          `Re-run the spike (docs/sw-patcher-spike.md) against this SW build.`,
      );
    }
    const cols = new Map<string, string>();
    for (const r of raw) {
      const row = TableInfoRowSchema.parse(r);
      cols.set(row.name.toLowerCase(), row.type.toUpperCase());
    }
    const missing: string[] = [];
    const typeMismatch: string[] = [];
    for (const [name, type] of TESTED_SW_SCHEMA) {
      const got = cols.get(name.toLowerCase());
      if (got == null) {
        missing.push(name);
      } else if (got !== type.toUpperCase()) {
        typeMismatch.push(`${name} (expected ${type}, got ${got})`);
      }
    }
    if (missing.length > 0 || typeMismatch.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing columns: ${missing.join(", ")}`);
      if (typeMismatch.length > 0) parts.push(`type mismatch: ${typeMismatch.join(", ")}`);
      throw new Error(
        `SW \`recording\` schema drifted from tested baseline (${parts.join("; ")}). ` +
          `Re-run the spike at docs/sw-patcher-spike.md and update TESTED_SW_SCHEMA.`,
      );
    }
    this.schemaValidated = true;
  }

  /**
   * Patch `datetime` on SW's row + the corresponding `meta.json` on
   * disk, then re-verify after `postPatchRecheckMs` and re-apply if
   * SW (or any other writer) clobbered our value. Up to
   * `postPatchMaxAttempts` total attempts before giving up.
   *
   * The re-verify loop is belt-and-braces: the quiescence-based
   * completion gate (`waitForCompletion`) should ensure SW has settled
   * before we get here, so the common path is `attempts = 1`. We pay
   * the 5 s wait only at the end of the loop after the first
   * apply-and-verify-immediate succeeds — single UPDATE, no SAVEPOINT
   * (see spike doc §4).
   */
  async patch(folderName: string, capturedAtIso: string): Promise<PatchResult> {
    this.validateSchema();

    const versionRowRaw: unknown = this.db
      .prepare("SELECT appVersion FROM recording WHERE folderName = ?")
      .get(folderName);
    if (versionRowRaw == null) {
      throw new Error(`SW row not found for folderName=${folderName}`);
    }
    const versionRow = AppVersionRowSchema.parse(versionRowRaw);
    const swAppVersion = versionRow.appVersion;
    const versionWarned =
      swAppVersion != null && !TESTED_SW_VERSIONS.includes(swAppVersion as never);
    if (versionWarned) {
      warn(
        `SW appVersion ${swAppVersion} not in tested set [${TESTED_SW_VERSIONS.join(", ")}]; ` +
          `proceeding with patch. Re-run docs/sw-patcher-spike.md against this SW build.`,
      );
    }

    let attempts = 0;
    while (attempts < this.postPatchMaxAttempts) {
      attempts += 1;
      this.applyPatch(folderName, capturedAtIso);
      await this.patchMetaJson(folderName, capturedAtIso);

      // Sleep, then re-read both surfaces. If either drifted, loop.
      await Bun.sleep(this.postPatchRecheckMs);
      const dbDriftReason = this.dbDriftReason(folderName, capturedAtIso);
      const metaDriftReason = await this.metaDriftReason(folderName, capturedAtIso);
      if (dbDriftReason == null && metaDriftReason == null) {
        if (attempts > 1) {
          verbose(
            `sw-patcher: patch settled after ${attempts} attempts (folder=${folderName})`,
          );
        }
        return { folderName, capturedAt: capturedAtIso, swAppVersion, versionWarned, attempts };
      }
      const reasons = [dbDriftReason, metaDriftReason].filter(Boolean).join("; ");
      warn(
        `sw-patcher: post-patch drift detected on attempt ${attempts}/` +
          `${this.postPatchMaxAttempts} for folder=${folderName}: ${reasons}`,
      );
    }
    throw new Error(
      `SW patch did not stick for folderName=${folderName} after ${this.postPatchMaxAttempts} attempts ` +
        `(post-patch recheck window=${this.postPatchRecheckMs} ms). ` +
        `Something is rewriting SW's row faster than the quiescence gate can detect.`,
    );
  }

  /**
   * Apply one UPDATE pass and immediately verify the read-back. Throws
   * if SQLite reports != 1 changed row, the row vanished, or the
   * read-back value doesn't match. Used by the patch() retry loop.
   */
  private applyPatch(folderName: string, capturedAtIso: string): void {
    const updateResult = this.db
      .prepare("UPDATE recording SET datetime = ? WHERE folderName = ?")
      .run(capturedAtIso, folderName);
    if (updateResult.changes !== 1) {
      throw new Error(
        `UPDATE recording changed ${updateResult.changes} rows for folderName=${folderName} (expected 1)`,
      );
    }
    const verifyRaw: unknown = this.db
      .prepare("SELECT datetime FROM recording WHERE folderName = ?")
      .get(folderName);
    if (verifyRaw == null) {
      throw new Error(`SW row vanished mid-patch for folderName=${folderName}`);
    }
    const verifyRow = DatetimeRowSchema.parse(verifyRaw);
    if (verifyRow.datetime !== capturedAtIso) {
      throw new Error(
        `SW datetime read-back mismatch: wanted ${capturedAtIso}, got ${verifyRow.datetime}`,
      );
    }
  }

  /**
   * Re-read SW's row and return a human-readable drift reason, or
   * null if the value still matches `capturedAtIso`.
   */
  private dbDriftReason(folderName: string, capturedAtIso: string): string | null {
    const raw: unknown = this.db
      .prepare("SELECT datetime FROM recording WHERE folderName = ?")
      .get(folderName);
    if (raw == null) {
      return `SW row disappeared for folderName=${folderName}`;
    }
    const row = DatetimeRowSchema.parse(raw);
    if (row.datetime !== capturedAtIso) {
      return `DB datetime drifted to ${JSON.stringify(row.datetime)}`;
    }
    return null;
  }

  /**
   * Re-read meta.json and return a human-readable drift reason, or
   * null if the value still matches `capturedAtIso`.
   */
  private async metaDriftReason(
    folderName: string,
    capturedAtIso: string,
  ): Promise<string | null> {
    const metaPath = join(this.recordingsDir, folderName, "meta.json");
    if (!existsSync(metaPath)) {
      return `meta.json disappeared at ${metaPath}`;
    }
    const json = (await Bun.file(metaPath).json()) as Record<string, unknown>;
    if (json.datetime !== capturedAtIso) {
      return `meta.json datetime drifted to ${JSON.stringify(json.datetime)}`;
    }
    return null;
  }

  close(): void {
    this.db.close();
  }

  private async patchMetaJson(folderName: string, capturedAtIso: string): Promise<void> {
    const metaPath = join(this.recordingsDir, folderName, "meta.json");
    if (!existsSync(metaPath)) {
      throw new Error(`meta.json missing for folderName=${folderName}: ${metaPath}`);
    }
    const file = Bun.file(metaPath);
    const json = (await file.json()) as Record<string, unknown>;
    json.datetime = capturedAtIso;
    const serialized = `${JSON.stringify(json, null, 2)}\n`;
    const tmpPath = `${metaPath}.tmp`;
    // Use node:fs writeFile + rename; Bun.write doesn't expose atomic
    // rename semantics. Write to a tmp sibling, then rename over the
    // target. POSIX rename within the same directory is atomic.
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, metaPath);

    // Verify by re-reading the meta.json from a fresh Bun.file handle.
    const verify = (await Bun.file(metaPath).json()) as Record<string, unknown>;
    if (verify.datetime !== capturedAtIso) {
      throw new Error(
        `meta.json verify failed for folderName=${folderName}: wanted ${capturedAtIso}, got ${String(verify.datetime)}`,
      );
    }
    // Touch the parent dir to make sure FSEvents downstream see the
    // change (best-effort; not a correctness requirement).
    void dirname(metaPath);
  }
}
