#!/usr/bin/env bun
/**
 * Build both Mach-O binaries (arm64 + x64) into `dist/`.
 *
 * The build is reproducible across architectures because:
 *  - the sqlite-vec dylibs for both targets are fetched fresh into
 *    `vendor/` (via `scripts/fetch-vec-dylibs.ts`)
 *  - asset filenames are pinned with `--asset-naming="[name].[ext]"` so the
 *    runtime can find them at `${tmpdir}/swrag-vec0-${user}/`.
 *  - Bun.embedded resolves the dylib through the cached vendor path.
 *
 * Outputs:
 *   dist/swrag-darwin-arm64
 *   dist/swrag-darwin-x64
 *   dist/swrag-darwin-arm64.tar.gz
 *   dist/swrag-darwin-x64.tar.gz
 *   dist/sha256sums.txt
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const ENTRY = "src/cli.ts";

interface Target {
  name: string;
  bunTarget: string;
}

const TARGETS: Target[] = [
  { name: "swrag-darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { name: "swrag-darwin-x64", bunTarget: "bun-darwin-x64" },
];

async function main() {
  console.log("[build] fetching vendor dylibs");
  const fetch = Bun.spawnSync({
    cmd: ["bun", "run", "scripts/fetch-vec-dylibs.ts"],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (fetch.exitCode !== 0) throw new Error("vendor fetch failed");

  // The Swift helper is built locally (no npm package to fetch from).
  // We always run the build script — it's idempotent and SPM's cache
  // makes a no-source-change rebuild near-instant.
  console.log("[build] building swift helper");
  const helper = Bun.spawnSync({
    cmd: ["bash", "scripts/build-swift-helper.sh"],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (helper.exitCode !== 0) {
    throw new Error(
      "swift helper build failed. " +
        "Run `bash scripts/build-swift-helper.sh` for the underlying error. " +
        "If the swift toolchain is missing, install Command Line Tools via " +
        "`xcode-select --install`.",
    );
  }
  const helperPath = join(ROOT, "vendor", "swrag-helper-darwin-universal");
  if (!existsSync(helperPath)) {
    throw new Error(`swift helper missing after build: ${helperPath}`);
  }

  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  for (const t of TARGETS) {
    const out = join(DIST, t.name);
    console.log(`[build] compiling ${t.name}`);
    const r = Bun.spawnSync({
      cmd: [
        "bun",
        "build",
        "--compile",
        `--target=${t.bunTarget}`,
        `--asset-naming=[name].[ext]`,
        "--minify",
        ENTRY,
        "--outfile",
        out,
      ],
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (r.exitCode !== 0) {
      throw new Error(`build failed for ${t.name}`);
    }
  }

  console.log("[build] tarballing");
  for (const t of TARGETS) {
    const r = Bun.spawnSync({
      cmd: ["tar", "-czf", `${t.name}.tar.gz`, t.name],
      cwd: DIST,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (r.exitCode !== 0) throw new Error(`tar failed for ${t.name}`);
  }

  console.log("[build] sha256sums");
  const r = Bun.spawnSync({
    cmd: ["bash", "-c", "shasum -a 256 *.tar.gz > sha256sums.txt"],
    cwd: DIST,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) throw new Error("shasum failed");

  console.log("[build] done");
}

await main();
