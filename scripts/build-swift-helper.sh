#!/usr/bin/env bash
# Build the Swift helper for arm64 + x86_64 and assemble a code-signed
# .app bundle at vendor/swrag-helper.app/. Also emit a deterministic
# tarball of the bundle at vendor/swrag-helper.app.tar — the compiled
# swrag CLI embeds the tarball via `with { type: "file" }` and
# extracts it to a per-user cache dir on first use.
#
# Why a bundle?
#
#   * macOS TCC tracks raw binaries by (absolute path + checksum).
#     Both change on every brew upgrade because the per-user cache
#     dir suffix encodes the file size. Result: Screen Recording /
#     Microphone grants are revoked on every release.
#
#   * A code-signed .app is tracked by (bundle identifier + sign
#     checksum). Ad-hoc sign with `--sign -` is sufficient for TCC
#     persistence; we don't need (and can't economically afford) a
#     Developer ID certificate.
#
#   * UNUserNotificationCenter (used by the `notify` subcommand)
#     refuses to register a delegate or post alerts outside of a
#     real bundle. The .app is a hard prerequisite for the native
#     start-recording banner.
#
# Idempotent: re-running with no source changes is fast because SPM
# caches builds per-arch.
#
# Layout produced:
#   swift-helper/.build/{arm64-apple-macosx,x86_64-apple-macosx}/release/SwragHelper
#   ↓ lipo
#   vendor/swrag-helper.app/Contents/MacOS/swrag-helper   (universal)
#   vendor/swrag-helper.app/Contents/Info.plist           (verbatim copy)
#   vendor/swrag-helper.app.tar                           (tarball of .app)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/swift-helper"
VENDOR_DIR="$REPO_ROOT/vendor"
APP_DIR="$VENDOR_DIR/swrag-helper.app"
APP_TAR="$VENDOR_DIR/swrag-helper.app.tar"

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

# Assemble bundle from scratch. We do `rm -rf` rather than overwriting
# in place so a previous-run with different layout never lingers.
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

echo "[swift-helper] lipo into $APP_DIR/Contents/MacOS/swrag-helper"
lipo -create -output "$APP_DIR/Contents/MacOS/swrag-helper" "$ARM_BIN" "$X64_BIN"
chmod +x "$APP_DIR/Contents/MacOS/swrag-helper"

cp "$PKG_DIR/Resources/Info.plist" "$APP_DIR/Contents/Info.plist"

# Sign the bundle.
#
# Default identity is `-` (ad-hoc). `--force` lets us re-sign over
# the existing identity every build (the bundle is fresh, but
# defensive); `--deep` walks nested executables — we only have one,
# but future-proofs against adding helper sub-binaries.
#
# Ad-hoc sign produces a stable signature checksum tied to the
# binary contents + Info.plist that TCC uses to identify the
# bundle across upgrades. The resulting binary works for mic-only
# capture out of the box; system audio capture on macOS Sequoia/
# Tahoe additionally requires a non-ad-hoc signature (see
# src/commands/setup-signing.ts and the README's "Enabling system
# audio recording" section). Users opt into that locally via
# `swrag setup-signing`; CI / power-users can pre-sign the bundle
# at build time by exporting SWRAG_SIGN_IDENTITY (any string
# `codesign --sign` accepts — typically a SHA-1 hex from
# `security find-identity -v -p codesigning`).
#
# When SWRAG_SIGN_IDENTITY is set we also pass `--options runtime`
# to enable the hardened runtime, which TCC on Tahoe needs for
# Screen Recording attribution to land correctly.
SIGN_IDENTITY="${SWRAG_SIGN_IDENTITY:--}"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  echo "[swift-helper] codesign --sign - (ad-hoc) $APP_DIR"
  codesign --force --deep --sign - "$APP_DIR"
else
  echo "[swift-helper] codesign --sign $SIGN_IDENTITY --options runtime $APP_DIR"
  codesign --force --deep --sign "$SIGN_IDENTITY" --options runtime "$APP_DIR"
fi
codesign --verify --deep --strict "$APP_DIR" 2>/dev/null || {
  echo "[swift-helper] error: codesign verification failed" >&2
  exit 1
}

# Tarball the bundle for embedding in the swrag CLI binary. We use
# `-C` so paths in the tarball start at `swrag-helper.app/...` (not
# `vendor/swrag-helper.app/...`), which keeps extraction simple on
# the runtime side. Plain tar (not gzip) — the swrag CLI is already
# inside a gzipped release tarball, so an inner gzip layer would
# just waste CPU.
echo "[swift-helper] tar -> $APP_TAR"
( cd "$VENDOR_DIR" && tar -cf "$APP_TAR" swrag-helper.app )

# Clean up the legacy raw binary path from v0.8.x so a partial-state
# checkout (or a tap formula that still points at the old path) fails
# loudly instead of silently running the previous version.
LEGACY_RAW="$VENDOR_DIR/swrag-helper-darwin-universal"
if [[ -e "$LEGACY_RAW" ]]; then
  echo "[swift-helper] removing legacy raw binary at $LEGACY_RAW"
  rm -f "$LEGACY_RAW"
fi

app_size=$(du -sh "$APP_DIR" | awk '{print $1}')
tar_size=$(stat -f%z "$APP_TAR")
echo "[swift-helper] bundle: $APP_DIR ($app_size on disk)"
echo "[swift-helper] tar:    $APP_TAR ($tar_size bytes)"
echo "[swift-helper] archs:"
lipo -info "$APP_DIR/Contents/MacOS/swrag-helper"
echo "[swift-helper] codesign:"
codesign -dvv "$APP_DIR" 2>&1 | sed 's/^/  /'
