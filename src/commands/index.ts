import { ensureFresh, type IngestResult } from "../ingest/ingester.ts";
import { info, verbose } from "../log.ts";
import { refreshInstalledSkills } from "./install-skill.ts";

export interface IndexCommandOptions {
  sourceDir: string;
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
  skipEmbeddings?: boolean;
}

export async function runIndex(opts: IndexCommandOptions): Promise<IngestResult> {
  const result = await ensureFresh({
    sourceDb: opts.sourceDb,
    sourceDir: opts.sourceDir,
    archive: opts.archive,
    embedModel: opts.embedModel,
    ollamaHost: opts.ollamaHost,
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

  // Auto-upgrade hook: if the user has installed skills and the bundled
  // SKILL.md has changed (e.g. because they just `brew upgrade`d), refresh
  // the on-disk copies in place — but only when the user hasn't edited
  // them since we last wrote (see install-skill.ts for the rules).
  // Best-effort; failures are logged at verbose level only — never
  // blocking ingest.
  try {
    const refreshed = (await refreshInstalledSkills(opts.archive)).filter((r) => r.refreshed);
    if (refreshed.length > 0) {
      info(`refreshed ${refreshed.length} skill file(s) to match the new binary`);
      for (const r of refreshed) verbose(`  ${r.path}`);
    }
  } catch (e) {
    verbose(`skill auto-refresh skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}
