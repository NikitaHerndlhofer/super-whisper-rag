/**
 * Resolves the path to the `sqlite-vec` loadable extension for the current
 * architecture.
 *
 * The two dylibs are embedded into the compiled binary via Bun's
 * `with { type: "file" }` import attribute. At dev time these resolve to the
 * absolute paths under `vendor/` and `dlopen()` can read them directly.
 * Inside a `bun build --compile` binary, however, the import resolves to a
 * `/$bunfs/...` virtual path that the system's `dlopen()` cannot read, so we
 * have to materialise the file on the real filesystem before loading.
 *
 * The materialised copy is cached per Bun runtime version + dylib content
 * hash to avoid stale extracts across upgrades. We pick a stable per-user
 * cache directory so a launchd-spawned process and a TTY-spawned process
 * share the same copy.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import dylibArm64 from "../../vendor/vec0-darwin-arm64.dylib" with { type: "file" };
import dylibX64 from "../../vendor/vec0-darwin-x64.dylib" with { type: "file" };

let cachedPath: string | null = null;

export function vecDylibPath(): string {
  if (cachedPath) return cachedPath;
  if (process.platform !== "darwin") {
    throw new Error(`unsupported platform: ${process.platform} (only darwin is supported)`);
  }
  const embedded = process.arch === "arm64" ? dylibArm64 : dylibX64;
  cachedPath = materialiseDylib(embedded);
  return cachedPath;
}

function materialiseDylib(embeddedPath: string): string {
  // If the embedded path is already a regular file on disk (dev mode), use
  // it directly; dlopen() handles it without extraction.
  if (!embeddedPath.startsWith("/$bunfs/") && existsSync(embeddedPath)) {
    return embeddedPath;
  }
  const data = readFileSync(embeddedPath);
  const size = data.byteLength;
  const username = safeUsername();
  const cacheDir = join(tmpdir(), `swrag-vec0-${username}`);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    // ignore
  }
  const target = join(cacheDir, `vec0-${process.arch}-${size}.dylib`);
  if (existsSync(target) && statSync(target).size === size) {
    return target;
  }
  // Atomic write: write to a temp path then rename so concurrent CLI calls
  // never observe a half-written dylib.
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, target);
  } catch {
    if (!existsSync(target) || statSync(target).size !== size)
      throw new Error("dylib install failed");
  }
  return target;
}

function safeUsername(): string {
  try {
    return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");
  } catch {
    return "user";
  }
}
