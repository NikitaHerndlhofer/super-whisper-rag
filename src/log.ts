import { EnvSchema } from "./schemas.ts";

// Verbose is opt-in via the SWRAG_VERBOSE env var. There is no --verbose
// flag — we want the CLI surface as small as possible.
const verboseEnabled = EnvSchema.parse(Bun.env).SWRAG_VERBOSE;

function ts(): string {
  return new Date().toISOString();
}

export function info(msg: string): void {
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
