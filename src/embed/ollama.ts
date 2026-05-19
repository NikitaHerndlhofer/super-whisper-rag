import { EMBED_TIMEOUT_MS } from "../config.ts";
import { DEFAULTS } from "../paths.ts";
import {
  OllamaEmbedResponseSchema,
  OllamaTagsResponseSchema,
} from "../schemas.ts";

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

const DEFAULT_KEEP_ALIVE = Bun.env.SWRAG_KEEP_ALIVE ?? "15m";

/**
 * Synchronous single-text embedding via curl.
 *
 * Used by the `swrag embed "text"` CLI command, which prints the resulting
 * vector as a SQLite blob literal (`x'…'`) on stdout. That output is meant
 * to be `$(swrag embed …)`-expanded into a SQL string at the shell layer
 * — `swrag embed` is part of a synchronous shell pipeline and has nowhere
 * to await a Promise. For bulk ingestion (`swrag index`) we use the async
 * `embedBatch` instead because it pipelines through fetch.
 */
export function embedSync(text: string, opts: EmbedOptions = {}): Float32Array {
  const host = opts.host ?? DEFAULTS.ollamaHost;
  const model = opts.model ?? DEFAULTS.embedModel;
  const timeoutMs = opts.timeoutMs ?? EMBED_TIMEOUT_MS;
  const keepAlive = opts.keepAlive ?? DEFAULT_KEEP_ALIVE;
  const maxTime = Math.max(1, Math.ceil(timeoutMs / 1000));

  const r = Bun.spawnSync({
    cmd: [
      "curl",
      "-sS",
      "--max-time",
      String(maxTime),
      "-X",
      "POST",
      `${host}/api/embed`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ model, input: [text], keep_alive: keepAlive }),
    ],
    timeout: timeoutMs + 500,
  });
  if (r.exitCode !== 0) {
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    throw new Error(
      `embed via curl failed (exit ${r.exitCode}): ${stderr || "no stderr"}`,
    );
  }
  const stdout = new TextDecoder().decode(r.stdout);
  const body = OllamaEmbedResponseSchema.parse(JSON.parse(stdout));
  const first = body.embeddings[0];
  if (!first) throw new Error("ollama returned no embeddings");
  return new Float32Array(first);
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
  const keepAlive = opts.keepAlive ?? DEFAULT_KEEP_ALIVE;

  const r = await fetchWithRetry(
    `${host}/api/embed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts, keep_alive: keepAlive }),
      signal: AbortSignal.timeout(timeoutMs),
    },
    3,
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ollama /api/embed ${r.status}: ${body}`);
  }
  const json: unknown = await r.json();
  const body = OllamaEmbedResponseSchema.parse(json);
  if (body.embeddings.length !== texts.length) {
    throw new Error(
      `ollama returned ${body.embeddings.length} vectors for ${texts.length} inputs`,
    );
  }
  return body.embeddings.map((arr) => new Float32Array(arr));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, init);
      if (r.ok || r.status < 500) return r;
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
export async function checkOllama(
  opts: EmbedOptions = {},
): Promise<string | null> {
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
  if (!have)
    return `embed model "${model}" not pulled. Run: ollama pull ${model}`;
  return null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
