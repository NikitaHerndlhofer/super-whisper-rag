// swift-tools-version:5.9
//
// The `swrag-helper` binary is a thin shim over a handful of macOS-only APIs
// the TS daemon cannot call directly: NSWorkspace notifications,
// CoreAudio property listeners, AVFoundation permission probes,
// CGPreflightScreenCaptureAccess, UNUserNotificationCenter, etc.
//
// Built as a single universal executable, then wrapped in a `.app`
// bundle at `vendor/swrag-helper.app/` by `scripts/build-swift-helper.sh`.
// The .app gives TCC a stable identity (`CFBundleIdentifier` +
// ad-hoc-sign checksum) so Screen Recording / Microphone grants
// survive `brew upgrade` (raw binaries are identified by absolute
// path + checksum, both of which change on every release). Bundling
// is also a hard prerequisite for `UNUserNotificationCenter`, used by
// the `notify` subcommand. `Resources/Info.plist` is copied verbatim
// into `Contents/Info.plist` at bundle-assembly time.
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
