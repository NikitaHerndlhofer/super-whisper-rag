import AppKit
import Foundation

// Bundle IDs that ≈ "the user is in a meeting right now" if the app
// is running (mic_in_use is OR'd separately by the TS detector).
// Kept in sync with `STRICT_CALL_APPS` / `SOFT_CALL_APPS` in
// `src/meeting/detect.ts` — the Swift side surfaces both lists in
// the running_call_apps payload; the TS side decides confidence.
let STRICT_CALL_APP_BUNDLE_IDS: Set<String> = [
  "us.zoom.xos",
  "com.microsoft.teams2",
  "com.microsoft.teams",
  "com.apple.FaceTime",
]

let SOFT_CALL_APP_BUNDLE_IDS: Set<String> = [
  "com.tinyspeck.slackmacgap",
  "com.hnc.Discord",
]

struct FrontmostAppPayload: Codable {
  let bundleId: String?
  let name: String?
  let pid: Int32?
  let runningCallApps: RunningCallApps

  struct RunningCallApps: Codable {
    let strict: [String]
    let soft: [String]
  }
}

func snapshotFrontmostApp() -> FrontmostAppPayload {
  let workspace = NSWorkspace.shared
  let front = workspace.frontmostApplication
  let running = workspace.runningApplications

  var strict: [String] = []
  var soft: [String] = []
  for app in running {
    guard let bid = app.bundleIdentifier else { continue }
    if STRICT_CALL_APP_BUNDLE_IDS.contains(bid) {
      strict.append(bid)
    } else if SOFT_CALL_APP_BUNDLE_IDS.contains(bid) {
      soft.append(bid)
    }
  }
  // dedupe while preserving insertion order (multiple instances of an
  // app — unusual but possible with Electron apps — should not double
  // count in the JSON output).
  let strictUnique = Array(NSOrderedSet(array: strict)) as? [String] ?? strict
  let softUnique = Array(NSOrderedSet(array: soft)) as? [String] ?? soft

  return FrontmostAppPayload(
    bundleId: front?.bundleIdentifier,
    name: front?.localizedName,
    pid: front?.processIdentifier,
    runningCallApps: .init(strict: strictUnique, soft: softUnique)
  )
}

func runFrontmostApp() {
  let payload = snapshotFrontmostApp()
  printJSON(payload)
  exit(0)
}
