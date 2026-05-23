#!/usr/bin/env bash
# Build the Swift helper for arm64 + x86_64 and lipo into a universal
# Mach-O at vendor/swrag-helper-darwin-universal.
#
# Idempotent: re-running with no source changes is a near-noop because
# SPM caches builds per-arch. Fail clearly when the swift toolchain is
# missing — Apple's Command Line Tools provide it; we don't fall back
# to a brittle "install Xcode" path.
#
# Layout:
#   swift-helper/.build/{arm64-apple-macosx,x86_64-apple-macosx}/release/SwragHelper
#   ↓ lipo
#   vendor/swrag-helper-darwin-universal
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/swift-helper"
VENDOR_DIR="$REPO_ROOT/vendor"
OUT="$VENDOR_DIR/swrag-helper-darwin-universal"

if ! command -v swift >/dev/null 2>&1; then
  echo "[swift-helper] error: 'swift' not found on PATH." >&2
  echo "[swift-helper]   install Apple's Command Line Tools:" >&2
  echo "[swift-helper]     xcode-select --install" >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"

echo "[swift-helper] building arm64"
( cd "$PKG_DIR" && swift build -c release --arch arm64 )
echo "[swift-helper] building x86_64"
( cd "$PKG_DIR" && swift build -c release --arch x86_64 )

ARM_BIN="$PKG_DIR/.build/arm64-apple-macosx/release/SwragHelper"
X64_BIN="$PKG_DIR/.build/x86_64-apple-macosx/release/SwragHelper"

if [[ ! -x "$ARM_BIN" ]]; then
  echo "[swift-helper] error: missing arm64 binary at $ARM_BIN" >&2
  exit 1
fi
if [[ ! -x "$X64_BIN" ]]; then
  echo "[swift-helper] error: missing x86_64 binary at $X64_BIN" >&2
  exit 1
fi

echo "[swift-helper] lipo into $OUT"
lipo -create -output "$OUT" "$ARM_BIN" "$X64_BIN"
chmod +x "$OUT"

size=$(stat -f%z "$OUT")
echo "[swift-helper] wrote $OUT ($size bytes)"
echo "[swift-helper] archs:"
lipo -info "$OUT"
