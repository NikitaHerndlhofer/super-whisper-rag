/**
 * Test-suite preload (wired up via `bunfig.toml`).
 *
 * Silences swrag's info/warn stderr output during `bun test` so failures
 * are easier to skim. Error-level output is still printed. To debug a
 * test that needs the logs, unset SWRAG_QUIET in the relevant test
 * (`delete process.env.SWRAG_QUIET; resetEnvForTests();`).
 */
import { resetEnvForTests } from "../src/env.ts";

process.env.SWRAG_QUIET = "1";
resetEnvForTests();
