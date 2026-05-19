import { z } from "zod";
import { vecDylibPath } from "../archive/vec-loader.ts";
import { findSqlite3Binary } from "../sqlite3.ts";

export const PathTargetSchema = z.enum(["archive", "sqlite3", "vec0"]);
export type PathTarget = z.infer<typeof PathTargetSchema>;

export interface PathOptions {
  target: PathTarget;
  archive: string;
}

/**
 * Print a filesystem path the user (or their shell) can use directly.
 *
 * - `archive`  → the swrag.sqlite path. Use with `sqlite3 $(swrag path)`.
 * - `sqlite3`  → the Homebrew sqlite3 binary we link against.
 * - `vec0`     → the materialised sqlite-vec dylib. Pair with `.load`.
 */
export function getPath(opts: PathOptions): string {
  switch (opts.target) {
    case "archive":
      return opts.archive;
    case "sqlite3":
      return findSqlite3Binary();
    case "vec0":
      return vecDylibPath();
  }
}
