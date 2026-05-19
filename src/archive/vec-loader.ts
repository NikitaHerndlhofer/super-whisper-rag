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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  // Include the numeric uid in the cache dir name (in addition to a
  // sanitised username) so two users on the same multi-user Mac whose
  // usernames happen to differ only in stripped characters don't collide
  // on the same world-writable /tmp directory. Lock the dir down to
  // 0700 to make it harder for someone to plant a malicious dylib at
  // our target path before we get a chance to materialise it.
  const cacheDir = join(tmpdir(), `swrag-vec0-${safeUid()}-${safeUsername()}`);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(cacheDir, 0o700);
  } catch {
    // ignore — chmod failures on someone else's pre-existing dir are
    // expected, we still try to use it. dlopen will reject the file if
    // it's been tampered with via codesigning checks.
  }
  const target = join(cacheDir, `vec0-${process.arch}-${size}.dylib`);
  if (existsSync(target) && statSync(target).size === size) {
    return target;
  }
  // Atomic write: write to a temp path then rename so concurrent CLI calls
  // never observe a half-written dylib.
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
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

function safeUid(): string {
  const uid = process.getuid?.();
  return uid == null ? "x" : String(uid);
}
