import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  cpSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { z } from "zod";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url).pathname;

/**
 * Helper for tests that need to query the archive and validate the shape of
 * the result without resorting to bun:sqlite's runtime-unverified generics.
 */
export function queryOne<T extends z.ZodTypeAny>(
  db: Database,
  schema: T,
  sql: string,
  ...args: SQLQueryBindings[]
): z.infer<T> {
  const raw: unknown = db.prepare(sql).get(...args);
  return schema.parse(raw);
}

export function queryAll<T extends z.ZodTypeAny>(
  db: Database,
  schema: T,
  sql: string,
  ...args: SQLQueryBindings[]
): z.infer<T>[] {
  const raw: unknown[] = db.prepare(sql).all(...args);
  return raw.map((r) => schema.parse(r));
}

export interface TestEnv {
  workDir: string;
  sourceDir: string;
  sourceDb: string;
  archive: string;
}

/**
 * Set up an isolated temp dir mirroring the on-disk layout that the
 * ingester expects (Super Whisper data root + recordings + DB).
 */
export function makeEnv(): TestEnv {
  const workDir = mkdtempSync(join(tmpdir(), "swrag-test-"));
  const sourceDir = join(workDir, "superwhisper");
  const recordingsSrc = join(FIXTURE_DIR, "recordings");
  const recordingsDst = join(sourceDir, "recordings");
  const dbSrc = join(FIXTURE_DIR, "superwhisper.sqlite");
  const dbDst = join(workDir, "source.sqlite");
  mkdirSync(sourceDir, { recursive: true });
  if (existsSync(recordingsSrc)) {
    cpSync(recordingsSrc, recordingsDst, { recursive: true });
  } else {
    mkdirSync(recordingsDst, { recursive: true });
  }
  copyFileSync(dbSrc, dbDst);
  const archive = join(workDir, "archive", "swrag.sqlite");
  mkdirSync(dirname(archive), { recursive: true });
  return { workDir, sourceDir, sourceDb: dbDst, archive };
}

/** Stub embed function: deterministic from text content. */
export async function stubEmbed(texts: string[]): Promise<Float32Array[]> {
  return texts.map((t) => deterministicVector(t));
}

function deterministicVector(text: string): Float32Array {
  const dim = 1024;
  const v = new Float32Array(dim);
  // Simple seed-based PRNG.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  let seed = h >>> 0;
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    v[i] = (seed / 0xffffffff) * 2 - 1;
  }
  // L2 normalise for cosine sanity.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (v[i] ?? 0) ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}
