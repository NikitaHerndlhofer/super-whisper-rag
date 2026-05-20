/**
 * Deterministic, LLM-free text chunker for long recordings.
 *
 * Single-vector retrieval is fine for the ~98% of recordings that are
 * short dictations. For the long-form minority (meetings, interviews) it
 * has two structural problems:
 *
 *   1. `bge-m3`'s ~8K-token window silently truncates the back half of
 *      anything over ~5K words — those passages aren't represented in
 *      `recording_vec` at all.
 *   2. Even within the token budget, a single embedding averages every
 *      topic discussed over an hour — "where did I mention pricing?"
 *      matches anything that brushed pricing, which is most meetings.
 *
 * This chunker splits long source text into ~300-word windows (50-word
 * overlap, sentence- and speaker-boundary-aware). The ingester embeds
 * each chunk separately into `recording_chunk_vec` and writes the
 * L2-normalized centroid back to `recording_vec` as a coarse signal for
 * filtering. See migration 004 for the schema and `embedDirtyRows` in
 * `ingester.ts` for the integration.
 *
 * This file is intentionally pure (no I/O, no DB, no Ollama). Tests in
 * `tests/chunking.test.ts` exercise it directly.
 */

export interface ChunkStrategy {
  /** Target chunk size in words. */
  size: number;
  /** Overlap between adjacent chunks in words. Must be < size. */
  overlap: number;
  /**
   * Word-count threshold below which a row is not chunked at all. Should
   * be ≥ size to avoid producing single-chunk docs that just duplicate
   * the whole-doc embedding.
   */
  threshold: number;
  /**
   * Window (in words) on either side of the target end-of-chunk in which
   * we look for a natural boundary. ±30 words is large enough to almost
   * always find a sentence in flowing speech, small enough to keep
   * chunks roughly uniform.
   */
  boundaryWindow: number;
  /**
   * Bump when chunker BEHAVIOR (not parameters) changes — e.g. a new
   * boundary heuristic, a different abbreviation list, etc. Stored
   * alongside the parameters in `config.chunk_strategy`; a version
   * mismatch triggers a rechunk on the next `swrag index`. Without
   * this, an algorithm-only improvement would silently leave existing
   * archives with stale chunks until the user happened to tune a
   * parameter.
   *
   * History:
   *   1 — initial release (sentence boundaries, bare `Speaker N:`).
   *   2 — also recognise bracketed `[Speaker N]:` (Super Whisper's
   *       actual format in 10 of 12 observed long meetings).
   */
  algoVersion: number;
}

export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = {
  size: 300,
  overlap: 50,
  threshold: 500,
  boundaryWindow: 30,
  algoVersion: 2,
};

export interface Chunk {
  /** Zero-based index within the recording. */
  chunk_idx: number;
  /** The chunk's text — the joined words; the chunker does not add the `[mode]` prefix. */
  text: string;
  /** Inclusive word offset into the tokenised source. */
  start_word: number;
  /** Inclusive word offset into the tokenised source. */
  end_word: number;
  /** end_word - start_word + 1. */
  word_count: number;
}

/**
 * Split `input` into chunks per `strategy`. Returns `[]` for inputs
 * below the configured threshold — short rows continue to use the
 * single-vector path in the ingester.
 *
 * Boundary preference order (inside the ±boundaryWindow region around
 * the target end-of-chunk):
 *
 *   1. **Speaker-turn** — when Super Whisper's meeting mode emits
 *      `Speaker N:` labels, breaking at a turn is a far stronger
 *      semantic boundary than a sentence inside a single speaker's
 *      monologue.
 *   2. **Sentence-final punctuation** (`. ! ?`), with abbreviation +
 *      decimal filters so `e.g.`, `Dr.`, `3.14`, and `...` don't trip
 *      false positives.
 *   3. **Hard split** at the target word count when no boundary is in
 *      the window.
 *
 * Marginal-tail merge: if the final chunk would have fewer than
 * `2 × overlap` net-new words (i.e., almost everything in it is
 * overlap from the predecessor), it's folded into the predecessor.
 * Guards against the off-by-one where a 551-word doc with size=300,
 * overlap=50 would otherwise emit a third chunk of ~51 words, 50 of
 * which are overlap.
 */
export function chunkText(input: string, strategy: ChunkStrategy = DEFAULT_CHUNK_STRATEGY): Chunk[] {
  if (strategy.size <= 0 || strategy.overlap < 0 || strategy.overlap >= strategy.size) {
    throw new Error(`chunkText: invalid strategy ${JSON.stringify(strategy)}`);
  }
  const { size, overlap, threshold, boundaryWindow } = strategy;

  const words = tokenize(input);
  if (words.length < threshold) return [];

  const sentenceEnd = computeSentenceEndFlags(words);
  const speakerStart = computeSpeakerStartFlags(words);
  const minTailNetNew = 2 * overlap;

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < words.length) {
    const targetEnd = Math.min(start + size - 1, words.length - 1);
    const isLast = targetEnd === words.length - 1;
    const actualEnd = isLast
      ? targetEnd
      : chooseEnd(start, targetEnd, boundaryWindow, words.length, speakerStart, sentenceEnd);

    chunks.push({
      chunk_idx: -1,
      text: words.slice(start, actualEnd + 1).join(" "),
      start_word: start,
      end_word: actualEnd,
      word_count: actualEnd - start + 1,
    });

    if (actualEnd === words.length - 1) break;

    // Next chunk starts `overlap` words before the boundary, but never
    // backwards from `start` (paranoia — sane size/overlap settings keep
    // chunks long enough that this is unreachable).
    const nextStart = Math.max(start + 1, actualEnd + 1 - overlap);
    start = nextStart;
  }

  mergeMarginalTail(chunks, words, minTailNetNew);

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c) c.chunk_idx = i;
  }
  return chunks;
}

function tokenize(s: string): string[] {
  const trimmed = s.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

/**
 * Returns boolean[] where `flags[i] === true` iff word `i` ends a sentence
 * — i.e., it would be safe to terminate a chunk at word `i` because the
 * next word starts a new sentence.
 *
 * Rules (all heuristics, conservative — missing a sentence boundary
 * falls back to the chunker's hard-split, which is harmless):
 *
 *   - `!` or `?` at end of word → yes (no abbreviations end in these).
 *   - `.` at end of word → yes UNLESS:
 *     - word ends in `..` (ellipsis or run-on punctuation), OR
 *     - word is in a small abbreviation set (`Mr.`, `e.g.`, ...), OR
 *     - word is ≤ 2 chars (handles initials like `J.` and the dotted
 *       components of `U.S.A.` while accepting that occasional initial-
 *       ending sentences will be missed), OR
 *     - word starts with a digit (decimals like `3.14`).
 */
function computeSentenceEndFlags(words: string[]): boolean[] {
  const out: boolean[] = new Array(words.length).fill(false);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w && endsSentence(w)) out[i] = true;
  }
  return out;
}

function endsSentence(word: string): boolean {
  const last = word[word.length - 1];
  if (last === "!" || last === "?") return true;
  if (last !== ".") return false;
  if (word.endsWith("..")) return false;
  if (/^\d/.test(word)) return false;
  if (word.length <= 2) return false;
  if (ABBREVIATIONS.has(word)) return false;
  return true;
}

const ABBREVIATIONS = new Set([
  "Mr.",
  "Mrs.",
  "Ms.",
  "Dr.",
  "Prof.",
  "Sr.",
  "Jr.",
  "St.",
  "vs.",
  "etc.",
  "e.g.",
  "i.e.",
  "Inc.",
  "Ltd.",
  "Co.",
  "Corp.",
]);

/**
 * Returns boolean[] where `flags[i] === true` iff word `i` starts a new
 * speaker turn. Detection is intentionally narrow but covers both
 * Super Whisper meeting-mode formats observed in the wild:
 *
 *   - **Bare**:       `Speaker 1: ...`   (word i = `Speaker`, word i+1 = `1:`)
 *   - **Bracketed**:  `[Speaker 1]: ...` (word i = `[Speaker`, word i+1 = `1]:`)
 *
 * A chunk that wants to break at a speaker boundary ends at word `i-1`
 * so the next chunk starts cleanly at the label.
 */
function computeSpeakerStartFlags(words: string[]): boolean[] {
  const out: boolean[] = new Array(words.length).fill(false);
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (!w || !next) continue;
    const bare = (w === "Speaker" || w === "SPEAKER") && /^\d+:$/.test(next);
    const bracketed =
      (w === "[Speaker" || w === "[SPEAKER") && /^\d+\]:$/.test(next);
    if (bare || bracketed) {
      out[i] = true;
    }
  }
  return out;
}

/**
 * Pick the actual end-of-chunk word index in `[targetEnd-window, targetEnd+window]`,
 * preferring (1) speaker-turn boundaries, (2) sentence-final punctuation,
 * (3) hard-split at targetEnd.
 *
 * For each candidate we record the index closest to `targetEnd`; ties
 * break toward the lower index (chunks tend to be slightly tighter than
 * `size`, never longer). All chosen indices satisfy `> start` so chunks
 * are non-empty.
 */
function chooseEnd(
  start: number,
  targetEnd: number,
  window: number,
  nWords: number,
  speakerStart: boolean[],
  sentenceEnd: boolean[],
): number {
  const lo = Math.max(start + 1, targetEnd - window);
  const hi = Math.min(nWords - 1, targetEnd + window);

  // Speaker boundary: word k starts a new turn → chunk ends at k-1.
  // Window for k-1 is [lo, hi], so k ranges over [lo+1, hi+1] (clipped).
  let bestSpeaker = -1;
  const speakerKLo = lo + 1;
  const speakerKHi = Math.min(hi + 1, nWords - 1);
  for (let k = speakerKLo; k <= speakerKHi; k++) {
    if (!speakerStart[k]) continue;
    const candidate = k - 1;
    if (candidate < start) continue;
    if (bestSpeaker < 0 || Math.abs(candidate - targetEnd) < Math.abs(bestSpeaker - targetEnd)) {
      bestSpeaker = candidate;
    }
  }
  if (bestSpeaker >= start) return bestSpeaker;

  // Sentence boundary: word k ends a sentence → chunk ends at k.
  let bestSentence = -1;
  for (let k = lo; k <= hi; k++) {
    if (!sentenceEnd[k]) continue;
    if (
      bestSentence < 0 ||
      Math.abs(k - targetEnd) < Math.abs(bestSentence - targetEnd)
    ) {
      bestSentence = k;
    }
  }
  if (bestSentence >= start) return bestSentence;

  return targetEnd;
}

/**
 * If the final chunk has fewer than `minTailNetNew` net-new words
 * (i.e., words past the previous chunk's `end_word`), fold it into the
 * predecessor. Mutates `chunks` in place.
 */
function mergeMarginalTail(chunks: Chunk[], words: string[], minTailNetNew: number): void {
  if (chunks.length < 2) return;
  const last = chunks[chunks.length - 1];
  const prev = chunks[chunks.length - 2];
  if (!last || !prev) return;
  const netNew = last.end_word - prev.end_word;
  if (netNew >= minTailNetNew) return;
  prev.end_word = last.end_word;
  prev.word_count = prev.end_word - prev.start_word + 1;
  prev.text = words.slice(prev.start_word, prev.end_word + 1).join(" ");
  chunks.pop();
}

/**
 * Pick the source body for chunking. Mirrors the precedence in the
 * ingester's `embedText`: prefer the LLM-cleaned transcript, fall back
 * to the raw transcription, return `""` if neither has content.
 *
 * Hoisted here so the threshold gate and the body selection share one
 * source of truth: a row is "long" iff `wordCountForChunking(r) > threshold`
 * where `wordCountForChunking` consults `llm_word_count` or
 * `raw_word_count` per the same precedence.
 */
export function chunkSourceBody(r: { llm_result: string | null; raw_result: string | null }): string {
  const body = r.llm_result || r.raw_result || "";
  return body.trim().length === 0 ? "" : body;
}

/**
 * Word count for the *body that would actually be chunked*. Matches the
 * `chunkSourceBody` precedence so the threshold check and the body
 * selection can't disagree.
 */
export function wordCountForChunking(r: {
  llm_result: string | null;
  raw_result: string | null;
  llm_word_count: number | null;
  raw_word_count: number | null;
}): number {
  if (r.llm_result) return r.llm_word_count ?? 0;
  if (r.raw_result) return r.raw_word_count ?? 0;
  return 0;
}

/**
 * Stable serialization of a `ChunkStrategy` for storage in the `config`
 * table. The serialized form is what the ingester compares against on
 * each run to detect `chunk_strategy` changes (one of the three
 * orthogonal dirty-detection rules — see `embedDirtyRows`).
 *
 * Key order is fixed so JSON byte-equality is a sufficient equality
 * check; we don't need to deep-compare parsed objects.
 */
export function serializeChunkStrategy(s: ChunkStrategy): string {
  return JSON.stringify({
    size: s.size,
    overlap: s.overlap,
    threshold: s.threshold,
    boundaryWindow: s.boundaryWindow,
    algoVersion: s.algoVersion,
  });
}
