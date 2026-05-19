import { EMBED_TIMEOUT_MS } from "../config.ts";
import { getEnv } from "../env.ts";
import { DEFAULTS } from "../paths.ts";
import { OllamaEmbedResponseSchema, OllamaTagsResponseSchema } from "../schemas.ts";

export interface EmbedOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * How long Ollama should keep the model loaded after the request.
   * - `"15m"` (our default): keep loaded for 15 minutes, so follow-up calls
   *   in a session skip the cold-load.
   * - `"0"`: unload immediately. Each call cold-loads (~5–15s).
   * - `"30s"`, `"5m"`, `"1h"`: keep loaded for that long.
   * - `"-1"`: keep loaded indefinitely (Ollama's default).
   * Override via `SWRAG_KEEP_ALIVE`. See
   * https://github.com/ollama/ollama/blob/main/docs/faq.md#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately
   */
  keepAlive?: string;
}

function defaultKeepAlive(): string {
  return getEnv().SWRAG_KEEP_ALIVE ?? "15m";
}

/**
 * Embed a single piece of text. Used by the `swrag embed "text"` CLI
 * command, which prints the resulting vector as a SQLite blob literal
 * (`x'…'`) for shell composition (`$(swrag embed 'q')`). Shells that
 * use command substitution wait for the child process to exit, so
 * there's no need to be synchronous internally; this is just a thin
 * wrapper around `embedBatch`.
 */
export async function embedOne(text: string, opts: EmbedOptions = {}): Promise<Float32Array> {
  const [v] = await embedBatch([text], opts);
  if (!v) throw new Error("ollama returned no embeddings");
  return v;
}

/** Batch embed via async fetch. Returns `texts.length` vectors in order. */
export async function embedBatch(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const host = opts.host ?? DEFAULTS.ollamaHost;
  const model = opts.model ?? DEFAULTS.embedModel;
  const timeoutMs = opts.timeoutMs ?? EMBED_TIMEOUT_MS * 6;
  const keepAlive = opts.keepAlive ?? defaultKeepAlive();

  const body = JSON.stringify({ model, input: texts, keep_alive: keepAlive });
  const r = await fetchWithRetry(
    `${host}/api/embed`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // A fresh timeout signal per attempt: AbortSignal.timeout fires
      // once and stays aborted forever, so reusing the same signal across
      // retries would make retries 2+ abort immediately. See the rationale
      // in `fetchWithRetry`.
      signal: AbortSignal.timeout(timeoutMs),
    }),
    3,
  );
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    throw new Error(`ollama /api/embed ${r.status}: ${errBody}`);
  }
  const json: unknown = await r.json();
  const parsed = OllamaEmbedResponseSchema.parse(json);
  if (parsed.embeddings.length !== texts.length) {
    throw new Error(
      `ollama returned ${parsed.embeddings.length} vectors for ${texts.length} inputs`,
    );
  }
  return parsed.embeddings.map((arr) => new Float32Array(arr));
}

/**
 * Retry transient failures with exponential backoff. `makeInit` is called
 * fresh per attempt so that `AbortSignal.timeout(...)` produces a new
 * signal each time — a shared `signal` would abort all retries the
 * instant the first timeout fires. We retry on network errors, 5xx, and
 * 429 (rate limit). Other 4xx are passed through to the caller untouched
 * because they're not transient.
 */
async function fetchWithRetry(
  url: string,
  makeInit: () => RequestInit,
  retries: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, makeInit());
      if (r.ok) return r;
      if (r.status < 500 && r.status !== 429) return r;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) {
      await new Promise((res) => setTimeout(res, 200 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Check that Ollama is reachable and the requested model is pulled. Returns
 * `null` on success; otherwise an actionable diagnostic string.
 */
export async function checkOllama(opts: EmbedOptions = {}): Promise<string | null> {
  const host = opts.host ?? DEFAULTS.ollamaHost;
  const model = opts.model ?? DEFAULTS.embedModel;
  let r: Response;
  try {
    r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
  } catch (e) {
    return `cannot reach Ollama at ${host}: ${errorMessage(e)}. Start it with: brew services start ollama`;
  }
  if (!r.ok) return `Ollama responded ${r.status} at ${host}`;
  const json: unknown = await r.json();
  const body = OllamaTagsResponseSchema.parse(json);
  const have = (body.models ?? []).some((m) => {
    const name = m.name ?? m.model ?? "";
    return name === model || name.startsWith(`${model}:`);
  });
  if (!have) return `embed model "${model}" not pulled. Run: ollama pull ${model}`;
  return null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
