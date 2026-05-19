import { EnvSchema } from "./schemas.ts";

// Verbose is opt-in via the SWRAG_VERBOSE env var. There is no --verbose
// flag — we want the CLI surface as small as possible.
let verboseEnabled = EnvSchema.parse(Bun.env).SWRAG_VERBOSE;
let jsonMode = false;

export function configureLogging(opts: { verbose?: boolean; json?: boolean }): void {
  if (opts.verbose !== undefined) verboseEnabled = opts.verbose;
  if (opts.json !== undefined) jsonMode = opts.json;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

function ts(): string {
  return new Date().toISOString();
}

export function info(msg: string): void {
  if (jsonMode) return;
  process.stderr.write(`[swrag] ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`[swrag] warn: ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`[swrag] error: ${msg}\n`);
}

export function verbose(msg: string): void {
  if (!verboseEnabled) return;
  process.stderr.write(`[swrag ${ts()}] ${msg}\n`);
}

export function progress(msg: string): void {
  if (jsonMode) return;
  process.stderr.write(`[swrag] ${msg}\n`);
}
