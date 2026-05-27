import { runWatch, type WatchOptions } from "../watch/watcher.ts";

/**
 * CLI entry for `swrag watch`. Thin pass-through to the watcher
 * module so the CLI doesn't need to know about debounce / signals.
 */
export async function runWatchCommand(opts: WatchOptions): Promise<void> {
  await runWatch(opts);
}
