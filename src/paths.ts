import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  PathOverridesSchema,
  ResolvedPathsSchema,
  type PathOverrides,
  type ResolvedPaths,
} from "./schemas.ts";

const HOME = homedir();

export const DEFAULTS = {
  sourceDir: join(HOME, "Documents", "superwhisper"),
  sourceDb: join(
    HOME,
    "Library",
    "Application Support",
    "superwhisper",
    "database",
    "superwhisper.sqlite",
  ),
  archive: join(
    HOME,
    "Library",
    "Application Support",
    "superwhisper-rag",
    "swrag.sqlite",
  ),
  logFile: join(HOME, "Library", "Logs", "superwhisper-rag.log"),
  launchAgentsDir: join(HOME, "Library", "LaunchAgents"),
  launchPlist: join(
    HOME,
    "Library",
    "LaunchAgents",
    "com.superwhisper-rag.sync.plist",
  ),
  cursorSkillDir: join(HOME, ".cursor", "skills", "superwhisper-rag"),
  claudeSkillDir: join(HOME, ".claude", "skills", "superwhisper-rag"),
  ollamaHost: "http://127.0.0.1:11434",
  embedModel: "bge-m3",
  embedDim: 1024,
};

export const BREW_SQLITE_PATHS = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
];

/**
 * Homebrew's `sqlite3` CLI binary. macOS's stock /usr/bin/sqlite3 is built
 * without loadable-extension support, so we always shell out to the Homebrew
 * one. This is the same binary that `brew install sqlite` provides — which
 * the Homebrew formula already declares as a dependency.
 */
export const BREW_SQLITE_BIN_PATHS = [
  "/opt/homebrew/opt/sqlite/bin/sqlite3",
  "/usr/local/opt/sqlite/bin/sqlite3",
];

export type { ResolvedPaths };

/**
 * Build a fully populated `ResolvedPaths` from optional overrides. Both the
 * input and the output are validated, so we never carry around partially
 * filled paths or stringy URLs. `archiveDir` is always derived from
 * `archive` — they are never independently overridable.
 */
export function resolvePaths(overrides: unknown = {}): ResolvedPaths {
  const o: PathOverrides = PathOverridesSchema.parse(overrides);
  const archive = o.archive ?? DEFAULTS.archive;
  return ResolvedPathsSchema.parse({
    sourceDir: o.sourceDir ?? DEFAULTS.sourceDir,
    sourceDb: o.sourceDb ?? DEFAULTS.sourceDb,
    archive,
    archiveDir: dirname(archive),
    ollamaHost: o.ollamaHost ?? DEFAULTS.ollamaHost,
    embedModel: o.embedModel ?? DEFAULTS.embedModel,
  });
}
