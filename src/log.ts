import { getEnv } from "./env.ts";

// Verbose is opt-in via the SWRAG_VERBOSE env var. There is no --verbose
// flag — we want the CLI surface as small as possible.
//
// All four functions write to stderr. Tests can silence info / warn /
// verbose via the `SWRAG_QUIET` env var (see `silenced()`); `error()`
// is deliberately exempt because suppressing error-level output makes
// test failures unreadable and there's never a good reason to silence
// it. If a future refactor "fixes the inconsistency", check the
// reasoning in tests/setup.ts before flipping it.
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
  // Intentionally not gated by SWRAG_QUIET — see top-of-file comment.
  process.stderr.write(`[swrag] error: ${msg}\n`);
}

export function verbose(msg: string): void {
  if (!getEnv().SWRAG_VERBOSE || silenced()) return;
  process.stderr.write(`[swrag ${ts()}] ${msg}\n`);
}
