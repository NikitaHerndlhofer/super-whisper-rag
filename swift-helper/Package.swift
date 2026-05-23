// swift-tools-version:5.9
//
// The `swrag-helper` binary is a thin shim over a handful of macOS-only APIs
// the TS daemon cannot call directly: NSWorkspace notifications,
// CoreAudio property listeners, AVFoundation permission probes,
// CGPreflightScreenCaptureAccess, etc.
//
// Built as a single executable. The release binary is then `lipo`-merged into
// a universal Mach-O at `vendor/swrag-helper-darwin-universal` so the same
// vendored asset works on both Apple Silicon and Intel.
import PackageDescription

let package = Package(
  name: "SwragHelper",
  platforms: [
    .macOS(.v13)
  ],
  targets: [
    .executableTarget(
      name: "SwragHelper",
      path: "Sources/SwragHelper"
    )
  ]
)
