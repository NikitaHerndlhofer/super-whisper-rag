/**
 * Test-suite preload (wired up via `bunfig.toml`).
 *
 * Silences swrag's info/warn stderr output during `bun test` so failures
 * are easier to skim. Error-level output is still printed. To debug a
 * test that needs the logs, unset SWRAG_QUIET in the relevant test
 * (`delete process.env.SWRAG_QUIET; resetEnvForTests();`).
 *
 * Also: `Database.setCustomSQLite(...)` can only be called BEFORE the
 * first `new Database(...)` in the process. Test files that open a
 * raw SW-shaped fixture DB (via `new Database`) before any
 * `openArchive` call would otherwise poison the global state and
 * subsequent `openArchive` calls fail to load the vec extension. Run
 * the helper here at preload time so every test file starts from a
 * "brew sqlite already applied" baseline.
 */
import { resetEnvForTests } from "../src/env.ts";
import { ensureExtensionCapableSqlite } from "../src/archive/open.ts";

process.env.SWRAG_QUIET = "1";
resetEnvForTests();
ensureExtensionCapableSqlite();
