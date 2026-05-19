import { EnvSchema, type PathOverrides } from "./schemas.ts";

/**
 * Load and validate the set of `SWRAG_*` / `OLLAMA_HOST` environment
 * overrides. Returns a partial override that `resolvePaths()` can layer on
 * top of `DEFAULTS`.
 */
export function loadEnvConfig(): PathOverrides {
  const env = EnvSchema.parse(Bun.env);
  return {
    sourceDir: env.SWRAG_SOURCE_DIR,
    sourceDb: env.SWRAG_SOURCE_DB,
    archive: env.SWRAG_ARCHIVE,
    ollamaHost: env.SWRAG_OLLAMA_HOST ?? env.OLLAMA_HOST,
    embedModel: env.SWRAG_EMBED_MODEL,
  };
}

export const VERSION = "0.1.0";
// Archive schema version is no longer a TypeScript constant — it lives in
// SQLite's `PRAGMA user_version` and is owned by `src/archive/migrate.ts`.
// See `src/archive/migrations.ts` for the migration list.
export const JSON_ENVELOPE_VERSION = 1;

/**
 * Per-call embed timeout. With `keep_alive: 0` (our default — see
 * `src/embed/ollama.ts`), Ollama cold-loads the model on every call, which
 * can take 5–15s on first invocation and ~1s thereafter. 30s gives plenty
 * of headroom.
 */
export const EMBED_TIMEOUT_MS = 30_000;
export const EMBED_BATCH_SIZE = 32;
export const EMBED_CACHE_SIZE = 1024;
export const EMBED_DIM = 1024;
