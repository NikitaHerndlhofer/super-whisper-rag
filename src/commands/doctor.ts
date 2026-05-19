import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { ensureExtensionCapableSqlite } from "../archive/open.ts";
import { vecDylibPath } from "../archive/vec-loader.ts";
import { checkOllama } from "../embed/ollama.ts";
import { findSqlite3Binary } from "../sqlite3.ts";

const VecVersionRowSchema = z.object({ v: z.string() });

export interface DoctorOptions {
  sourceDb: string;
  archive: string;
  embedModel: string;
  ollamaHost: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

/**
 * Minimal environment check. Verifies the three pieces we actually depend
 * on at runtime: a sqlite3 binary that supports loadable extensions, the
 * sqlite-vec extension, and Ollama with the requested model.
 *
 * The source DB and archive are intentionally not checked here — `swrag
 * index` will surface a clear error if either is missing.
 */
export async function runDoctor(opts: DoctorOptions): Promise<{
  exitCode: number;
  output: string;
}> {
  const checks: Check[] = [];

  const sqlite3 = safeCheck(
    "sqlite3 binary (extension-capable)",
    () => findSqlite3Binary(),
    "brew install sqlite",
  );
  checks.push(sqlite3);

  const dylib = ensureExtensionCapableSqlite();
  checks.push({
    name: "bun:sqlite custom build",
    ok: dylib.dylib != null,
    detail: dylib.dylib ?? "(using stock SQLite — extensions disabled)",
    hint: dylib.dylib ? undefined : "brew install sqlite",
  });

  let vecOk = false;
  let vecDetail = "";
  try {
    const db = new Database(":memory:");
    db.loadExtension(vecDylibPath(), "sqlite3_vec_init");
    const raw: unknown = db.prepare("SELECT vec_version() AS v").get();
    vecDetail = `sqlite-vec ${VecVersionRowSchema.parse(raw).v}`;
    db.close();
    vecOk = true;
  } catch (e) {
    vecDetail = e instanceof Error ? e.message : String(e);
  }
  checks.push({
    name: "sqlite-vec loadable",
    ok: vecOk,
    detail: vecDetail,
  });

  const ollamaErr = await checkOllama({
    host: opts.ollamaHost,
    model: opts.embedModel,
  });
  checks.push({
    name: `Ollama at ${opts.ollamaHost}`,
    ok: ollamaErr == null,
    detail: ollamaErr ?? `${opts.embedModel} reachable`,
    hint:
      ollamaErr == null
        ? undefined
        : ollamaErr.includes("not pulled")
          ? `ollama pull ${opts.embedModel}`
          : "brew install ollama && brew services start ollama",
  });

  if (existsSync(opts.archive)) {
    checks.push({
      name: "archive present",
      ok: true,
      detail: opts.archive,
    });
  }

  const ok = checks.every((c) => c.ok);
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`  [${c.ok ? "ok  " : "FAIL"}] ${c.name} — ${c.detail}`);
    if (!c.ok && c.hint) lines.push(`         hint: ${c.hint}`);
  }
  lines.push("");
  lines.push(ok ? "All checks passed." : "One or more checks failed.");
  return { exitCode: ok ? 0 : 2, output: `${lines.join("\n")}\n` };
}

function safeCheck(name: string, fn: () => string, hint: string): Check {
  try {
    return { name, ok: true, detail: fn() };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      hint,
    };
  }
}
