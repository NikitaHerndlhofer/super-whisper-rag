#!/usr/bin/env bun
/**
 * Fetch the platform-specific `vec0.dylib` binaries from npm and place them in
 * `vendor/`.
 *
 * Why: `bun install` will skip `sqlite-vec-darwin-x64` on an arm64 host (and
 * vice versa) because of the package's `os`/`cpu` fields. To produce
 * cross-architecture Mach-O binaries via `bun build --compile --target=...`,
 * we need both dylibs present at build time. Downloading them straight from
 * the npm registry side-steps the platform check.
 *
 * Idempotent: skips files that already exist with non-zero size.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VENDOR_DIR = new URL("../vendor/", import.meta.url).pathname;
const SCRATCH_DIR = join(tmpdir(), "swrag-vendor-fetch");

interface Target {
  pkg: string;
  version: string;
  outFile: string;
}

const TARGETS: Target[] = [
  {
    pkg: "sqlite-vec-darwin-arm64",
    version: "0.1.9",
    outFile: "vec0-darwin-arm64.dylib",
  },
  {
    pkg: "sqlite-vec-darwin-x64",
    version: "0.1.9",
    outFile: "vec0-darwin-x64.dylib",
  },
];

async function main() {
  await mkdir(VENDOR_DIR, { recursive: true });
  await mkdir(SCRATCH_DIR, { recursive: true });
  try {
    for (const t of TARGETS) {
      const out = join(VENDOR_DIR, t.outFile);
      if (existsSync(out) && statSync(out).size > 0) {
        console.log(`[vendor] ${t.outFile} already present`);
        continue;
      }
      console.log(`[vendor] fetching ${t.pkg}@${t.version}`);
      const url = `https://registry.npmjs.org/${t.pkg}/-/${t.pkg}-${t.version}.tgz`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`failed to fetch ${url}: ${r.status}`);
      const tgz = Buffer.from(await r.arrayBuffer());
      const dylib = await extractDylibFromTgz(tgz);
      await writeFile(out, dylib);
      console.log(`[vendor] wrote ${out} (${dylib.length} bytes)`);
    }
  } finally {
    await rm(SCRATCH_DIR, { recursive: true, force: true });
  }
}

/**
 * Extract `package/vec0.dylib` from an npm tarball without pulling in any
 * tar/gzip dependency: we shell out to the system `tar` which is on every
 * macOS by default.
 */
async function extractDylibFromTgz(tgz: Buffer): Promise<Buffer> {
  const tgzPath = join(SCRATCH_DIR, `pkg-${Date.now()}.tgz`);
  await writeFile(tgzPath, tgz);
  const r = Bun.spawnSync({
    cmd: ["tar", "-xzf", tgzPath, "-C", SCRATCH_DIR, "package/vec0.dylib"],
    timeout: 30_000,
  });
  if (r.exitCode !== 0) {
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    throw new Error(`tar extraction failed: ${stderr}`);
  }
  const dylibPath = join(SCRATCH_DIR, "package", "vec0.dylib");
  return Buffer.from(await Bun.file(dylibPath).bytes());
}

await main();
