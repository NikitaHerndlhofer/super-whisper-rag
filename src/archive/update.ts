/**
 * Data-updater runner.
 *
 * Mirrors `runMigrations` but for the data-side of the world. While
 * migrations evolve the schema and are tracked by SQLite's built-in
 * `PRAGMA user_version`, updaters evolve *data / computed state* (e.g.
 * "long rows now need chunk rows") and are tracked by the
 * `data_version` row in our `config` table.
 *
 * The runner is intentionally simple: read stored version, filter
 * `UPDATERS` to anything strictly greater, run each in order. If one
 * throws, abort the run (no further updaters execute) and leave
 * `data_version` where it was — the next `swrag index` will retry the
 * pending updaters. That gives us at-least-once semantics; individual
 * updaters are responsible for being idempotent if they want
 * exactly-once.
 *
 * Updaters run *outside* any transaction the runner controls. They may
 * be slow (network I/O), and they may open their own short transactions
 * for local writes.
 */
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { verbose } from "../log.ts";
import { getConfig, setConfig } from "./open.ts";
import type { IngestOptions } from "../ingest/ingester.ts";
import { LATEST_DATA_VERSION, UPDATERS, type Updater } from "./updaters.ts";

const DataVersionSchema = z.coerce.number().int().nonnegative();

export interface UpdaterOutcome {
  /** data_version before update ran. */
  fromVersion: number;
  /** data_version after update ran. */
  toVersion: number;
  /** Version numbers actually applied this run. */
  applied: number[];
}

/**
 * Run pending updaters. The optional `updaters` parameter exists so tests
 * can inject a stub list (e.g. a failing updater) without monkey-patching
 * the module-level export; production callers pass nothing and get the
 * real `UPDATERS`.
 */
export async function runUpdaters(
  archive: Database,
  opts: IngestOptions,
  updaters: readonly Updater[] = UPDATERS,
): Promise<UpdaterOutcome> {
  const from = readDataVersion(archive);
  const pending = updaters.filter((u) => u.version > from).sort((a, b) => a.version - b.version);
  const applied: number[] = [];
  for (const u of pending) {
    await u.fn(archive, opts);
    applied.push(u.version);
  }
  if (applied.length > 0) {
    const latest = Math.max(...updaters.map((u) => u.version));
    setConfig(archive, "data_version", String(latest));
  }
  const to = readDataVersion(archive);
  if (applied.length > 0) {
    verbose(`update: ${from} -> ${to} (applied ${applied.join(", ")})`);
  }
  return { fromVersion: from, toVersion: to, applied };
}

function readDataVersion(archive: Database): number {
  const raw = getConfig(archive, "data_version");
  if (raw == null) return 0;
  return DataVersionSchema.parse(raw);
}

export { LATEST_DATA_VERSION };
