/**
 * Memoised, validated view of the process environment.
 *
 * Every consumer (CLI entry, logger, ingester, …) goes through `getEnv()`
 * so the `EnvSchema` parse happens exactly once per process. Tests that
 * need to flip a knob can call `resetEnvForTests()` between cases.
 */
import { EnvSchema, type Env } from "./schemas.ts";

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached == null) cached = EnvSchema.parse(Bun.env);
  return cached;
}

export function resetEnvForTests(): void {
  cached = null;
}
