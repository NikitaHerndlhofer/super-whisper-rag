/**
 * Tiny LRU cache for memoising query embeddings within a single CLI run.
 *
 * The cache lives only for the duration of one process: across CLI invocations
 * we expect query texts to differ. The cache is invaluable when the same
 * embed call appears multiple times within one SQL statement (e.g. a CTE plus
 * the outer SELECT).
 */
export interface LRU<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  size(): number;
  has(key: K): boolean;
  clear(): void;
}

export function lru<K, V>(maxEntries: number): LRU<K, V> {
  const map = new Map<K, V>();
  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    size() {
      return map.size;
    },
    has(key) {
      return map.has(key);
    },
    clear() {
      map.clear();
    },
  };
}
