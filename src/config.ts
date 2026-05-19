export const VERSION = "0.5.0";

/**
 * Per-call embed timeout. With `keep_alive: "15m"` (our default — see
 * `src/embed/ollama.ts`), Ollama keeps the model loaded across a typical
 * session, so the first call after an idle period can still cold-load (~5–15s)
 * but subsequent calls return in ~100 ms. 30s gives plenty of headroom.
 */
export const EMBED_TIMEOUT_MS = 30_000;
export const EMBED_BATCH_SIZE = 32;
export const EMBED_DIM = 1024;
