import { getEnv } from "./env.ts";

// Verbose is opt-in via the SWRAG_VERBOSE env var. There is no --verbose
// flag — we want the CLI surface as small as possible.
//
// All four functions write to stderr. Tests can silence them by stubbing
// process.stderr.write or by routing through the `SWRAG_QUIET` env var
// (see `silenced()`).
function ts(): string {
  return new Date().toISOString();
}

function silenced(): boolean {
  return getEnv().SWRAG_QUIET;
}

export function info(msg: string): void {
  if (silenced()) return;
  process.stderr.write(`[swrag] ${msg}\n`);
}

export function warn(msg: string): void {
  if (silenced()) return;
  process.stderr.write(`[swrag] warn: ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`[swrag] error: ${msg}\n`);
}

export function verbose(msg: string): void {
  if (!getEnv().SWRAG_VERBOSE || silenced()) return;
  process.stderr.write(`[swrag ${ts()}] ${msg}\n`);
}
