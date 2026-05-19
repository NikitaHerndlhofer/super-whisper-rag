/**
 * Single source of truth for all runtime-validated data shapes.
 *
 * Every external input (env vars, CLI args, meta.json, source-DB rows,
 * Ollama responses) is parsed through a zod schema here. Internal data
 * types are the inferred TypeScript types, so we never cast or trust
 * unchecked `unknown`.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Environment / CLI args                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Boolean-ish env flag: empty / unset / "0" / "false" → false, anything
 * else → true. Lenient on purpose because shell quoting is fragile and
 * we want `SWRAG_VERBOSE=1` to "just work".
 */
const BoolFlag = z
  .string()
  .optional()
  .transform((v) => {
    if (v == null) return false;
    const s = v.trim().toLowerCase();
    return s.length > 0 && s !== "0" && s !== "false" && s !== "no";
  });

export const EnvSchema = z.object({
  SWRAG_SOURCE_DIR: z.string().optional(),
  SWRAG_SOURCE_DB: z.string().optional(),
  SWRAG_ARCHIVE: z.string().optional(),
  SWRAG_OLLAMA_HOST: z.url().optional(),
  OLLAMA_HOST: z.url().optional(),
  SWRAG_EMBED_MODEL: z.string().optional(),
  SWRAG_SQLITE_DYLIB: z.string().optional(),
  SWRAG_VERBOSE: BoolFlag,
  SWRAG_SKIP_EMBED: BoolFlag,
});
export type Env = z.infer<typeof EnvSchema>;

export const PathOverridesSchema = z.object({
  sourceDir: z.string().optional(),
  sourceDb: z.string().optional(),
  archive: z.string().optional(),
  ollamaHost: z.url().optional(),
  embedModel: z.string().optional(),
});
export type PathOverrides = z.infer<typeof PathOverridesSchema>;

export const ResolvedPathsSchema = z.object({
  sourceDir: z.string(),
  sourceDb: z.string(),
  archive: z.string(),
  archiveDir: z.string(),
  ollamaHost: z.url(),
  embedModel: z.string().min(1),
});
export type ResolvedPaths = z.infer<typeof ResolvedPathsSchema>;

/* -------------------------------------------------------------------------- */
/* Source database row (Super Whisper's own SQLite)                           */
/* -------------------------------------------------------------------------- */

const NullableString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v == null ? null : v));

const NullableNumber = z
  .union([z.number(), z.null(), z.undefined()])
  .transform((v) => (v == null ? null : v));

/**
 * One row coming out of Super Whisper's `recording` table. Field names use
 * Super Whisper's camelCase column names. We normalise to nulls so the rest
 * of the pipeline doesn't carry `undefined`s.
 */
export const SourceRecordingSchema = z.object({
  folderName: z.string(),
  recordingIdHex: z.string(),
  datetime: z.string(),
  durationMs: z.number(),
  modeName: z.string(),
  modelKey: NullableString,
  modelName: NullableString,
  languageModelKey: NullableString,
  languageModelName: NullableString,
  recordingDevice: NullableString,
  rawWordCount: NullableNumber,
  llmWordCount: NullableNumber,
  result: NullableString,
  llmResult: NullableString,
  rawResult: NullableString,
});
export type SourceRecording = z.infer<typeof SourceRecordingSchema>;

/* -------------------------------------------------------------------------- */
/* meta.json (Super Whisper's per-recording metadata)                         */
/* -------------------------------------------------------------------------- */

/**
 * We only validate the subset we read. Everything else is preserved as-is via
 * passthrough so power users can poke at the raw payload from SQL.
 */
export const MetaJsonSchema = z.looseObject({
  promptContext: z
    .looseObject({
      modeContext: z
        .looseObject({
          language: z.string().optional(),
        })
        .optional(),
      applicationContext: z
        .looseObject({
          name: z.string().optional(),
          category: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  segments: z.unknown().optional(),
});
export type MetaJson = z.infer<typeof MetaJsonSchema>;

/* -------------------------------------------------------------------------- */
/* Ollama API                                                                 */
/* -------------------------------------------------------------------------- */

export const OllamaEmbedResponseSchema = z.object({
  embeddings: z.array(z.array(z.number())).min(1),
});
export type OllamaEmbedResponse = z.infer<typeof OllamaEmbedResponseSchema>;

export const OllamaTagsResponseSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string().optional(),
        model: z.string().optional(),
      }),
    )
    .optional(),
});
export type OllamaTagsResponse = z.infer<typeof OllamaTagsResponseSchema>;
