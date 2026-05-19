import { embedSync } from "../embed/ollama.ts";

export interface EmbedOptions {
  text: string;
  embedModel: string;
  ollamaHost: string;
}

/**
 * Compute an embedding and emit it as a SQLite blob literal (`x'…'`).
 *
 * Designed for shell composition with `swrag sql`:
 *
 *   swrag sql "SELECT folder_name FROM recording_vec
 *              ORDER BY vec_distance_cosine(embedding, $(swrag embed 'hello'))
 *              LIMIT 10"
 *
 * Or with raw sqlite3:
 *
 *   sqlite3 "$(swrag path)" \
 *     -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
 *     "SELECT ... vec_distance_cosine(embedding, $(swrag embed 'hello')) ..."
 */
export function runEmbed(opts: EmbedOptions): string {
  const vec = embedSync(opts.text, {
    host: opts.ollamaHost,
    model: opts.embedModel,
  });
  return `${floatVecToBlobLiteral(vec)}\n`;
}

/**
 * Encode a Float32Array as a SQLite blob literal (`x'aabbcc…'`) suitable
 * for inlining into a SQL string. Endianness is host-native, matching what
 * sqlite-vec stores and reads.
 */
function floatVecToBlobLiteral(vec: Float32Array): string {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `x'${hex}'`;
}
