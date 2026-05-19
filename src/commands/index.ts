import { ensureFresh, type IngestResult } from "../ingest/ingester.ts";
import { info } from "../log.ts";

export interface IndexCommandOptions {
  sourceDir: string;
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
  full: boolean;
  dryRun: boolean;
  skipEmbeddings?: boolean;
}

export async function runIndex(opts: IndexCommandOptions): Promise<IngestResult> {
  const result = await ensureFresh({
    sourceDb: opts.sourceDb,
    sourceDir: opts.sourceDir,
    archive: opts.archive,
    embedModel: opts.embedModel,
    ollamaHost: opts.ollamaHost,
    full: opts.full,
    dryRun: opts.dryRun,
    skipEmbeddings: opts.skipEmbeddings,
  });
  if (result.fastPath) {
    info("source unchanged; nothing to do");
  } else {
    info(
      `ingested ${result.newRows} new, ${result.updatedRows} updated, ${result.embedded} embedded, ` +
        `${result.sourceDeletions} marked deleted, ${result.audioChanges} audio changes ` +
        `(${result.durationMs} ms)`,
    );
  }
  return result;
}
