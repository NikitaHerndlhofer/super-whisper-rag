import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation

// Browsers we know how to query via Apple Events. Order matches the TS
// `src/mac/browser-url.ts` dispatch table; both sides agree on bundle IDs.
let SUPPORTED_BROWSER_BUNDLE_IDS: [String] = [
  "com.apple.Safari",
  "com.google.Chrome",
  "com.brave.Browser",
  "company.thebrowser.Browser",
  "com.vivaldi.Vivaldi",
  "com.microsoft.edgemac",
  "ai.perplexity.comet",
]

// Display names used by NSAppleScript `tell application "X"`. Maps from
// bundle ID — multiple variants exist (e.g. Chrome's display name is
// "Google Chrome" even though the bundle is `com.google.Chrome`).
let BROWSER_APP_NAMES: [String: String] = [
  "com.apple.Safari": "Safari",
  "com.google.Chrome": "Google Chrome",
  "com.brave.Browser": "Brave Browser",
  "company.thebrowser.Browser": "Arc",
  "com.vivaldi.Vivaldi": "Vivaldi",
  "com.microsoft.edgemac": "Microsoft Edge",
  "ai.perplexity.comet": "Comet",
]

struct PermissionsPayload: Codable {
  let microphone: String
  let screenRecording: String
  let automation: [String: String]
  let notifications: String
  let accessibility: String

  enum CodingKeys: String, CodingKey {
    case microphone
    case screenRecording = "screen_recording"
    case automation
    case notifications
    case accessibility
  }
}

func runPermissionsCheck(prompt: Bool) {
  let mic = checkMicrophone(prompt: prompt)
  let scr = checkScreenRecording(prompt: prompt)
  let automation = checkAutomation(prompt: prompt)
  // Notifications: the .app bundle is a prerequisite for
  // UNUserNotificationCenter to function at all; with the v0.9.0
  // bundle the probe is meaningful. `--prompt` fires the system
  // dialog (one-time per .app identity, persisted via TCC).
  let notif = prompt ? promptNotificationAuthorization() : probeNotificationAuthorization()
  // Accessibility (v0.9.11): required for the menubar's opt-in
  // `record_stop` global hotkey. Without this grant
  // `addGlobalMonitorForEvents` silently never fires. Probed via
  // `AXIsProcessTrustedWithOptions` which is a synchronous API —
  // when `--prompt` is set we hand it `kAXTrustedCheckOptionPrompt`
  // so the system pops the standard "X would like to control your
  // computer" dialog the first time; on subsequent invocations the
  // value is cached and the dialog doesn't re-fire.
  let access = checkAccessibility(prompt: prompt)
  let payload = PermissionsPayload(
    microphone: mic,
    screenRecording: scr,
    automation: automation,
    notifications: notif,
    accessibility: access
  )
  printJSON(payload)
  exit(0)
}

// MARK: - Microphone

private func checkMicrophone(prompt: Bool) -> String {
  let status = AVCaptureDevice.authorizationStatus(for: .audio)
  if prompt && status == .notDetermined {
    // Synchronously wait for the dialog response. The TS caller blocks
    // on our exit, so a 0–30 s pause here is expected behaviour when
    // `--prompt` is set; CI runs it without `--prompt` and gets the
    // current status instantly.
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
    sem.wait()
    return mapAVAuthStatus(AVCaptureDevice.authorizationStatus(for: .audio))
  }
  return mapAVAuthStatus(status)
}

private func mapAVAuthStatus(_ s: AVAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "granted"
  case .denied, .restricted: return "denied"
  case .notDetermined: return "not_determined"
  @unknown default: return "not_determined"
  }
}

// MARK: - Screen Recording

private func checkScreenRecording(prompt: Bool) -> String {
  let granted = CGPreflightScreenCaptureAccess()
  if granted { return "granted" }
  if prompt {
    let triggered = CGRequestScreenCaptureAccess()
    // CGRequestScreenCaptureAccess returns synchronously but the user's
    // decision is async (System Settings dialog). Re-check preflight
    // for callers that pass --prompt; if still denied, surface that.
    let after = CGPreflightScreenCaptureAccess()
    return after ? "granted" : (triggered ? "not_determined" : "denied")
  }
  return "not_determined"
}

// MARK: - Accessibility (v0.9.11)

/// Probe — and optionally trigger the system grant prompt for —
/// macOS Accessibility permission. Required for the menubar's opt-in
/// stop-recording global hotkey: `NSEvent.addGlobalMonitorForEvents`
/// silently never invokes its handler if the calling process isn't
/// listed as trusted under System Settings → Privacy & Security →
/// Accessibility.
///
/// Returns one of `granted` / `denied`. We don't surface
/// `not_determined` because the underlying
/// `AXIsProcessTrustedWithOptions` doesn't expose a "first-launch"
/// state — it returns false until the user explicitly toggles the
/// app on, then returns true forever. Mapping false → "denied" is
/// honest about the user-facing reality even on a fresh install
/// (the hotkey won't fire until the toggle is on).
///
/// With `prompt=true` we set `kAXTrustedCheckOptionPrompt` so the
/// first call surfaces the system dialog directing the user to the
/// right Settings pane. The dialog itself is non-blocking — the
/// function still returns the *current* trusted state before the
/// user has had a chance to act — so callers should expect "denied"
/// even from the prompting path on the very first run. The user
/// re-runs `swrag meeting permissions-check` after granting to
/// confirm.
private func checkAccessibility(prompt: Bool) -> String {
  // String-key form of `kAXTrustedCheckOptionPrompt` so we don't have
  // to bridge a `CFString` through Swift's NSDictionary surface; the
  // ApplicationServices header documents both forms as equivalent.
  let key = "AXTrustedCheckOptionPrompt" as CFString
  let opts: CFDictionary = [key: prompt] as CFDictionary
  return AXIsProcessTrustedWithOptions(opts) ? "granted" : "denied"
}

// MARK: - Apple Events / Automation per browser

/// For each known browser:
///   - "not_installed" if the bundle id isn't registered with LaunchServices.
///   - "granted" if the browser is installed AND a no-op AppleScript runs OK.
///   - "denied" if the browser is installed but the AppleScript returns
///     errAEEventNotPermitted (-1743) or similar.
///   - "not_determined" if we couldn't classify (rare).
///
/// With `--prompt`, the AppleScript invocation itself IS the prompt:
/// macOS shows the Apple Events permission dialog on first contact and
/// remembers the user's choice. Subsequent invocations return granted
/// / denied without prompting.
private func checkAutomation(prompt: Bool) -> [String: String] {
  var out: [String: String] = [:]
  for bundleId in SUPPORTED_BROWSER_BUNDLE_IDS {
    out[bundleId] = checkAutomationFor(bundleId: bundleId, prompt: prompt)
  }
  return out
}

private func checkAutomationFor(bundleId: String, prompt: Bool) -> String {
  guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
    return "not_installed"
  }
  _ = appURL  // installed; carry on to the scripting probe
  guard let appName = BROWSER_APP_NAMES[bundleId] else {
    // No display name mapped — treat as "not_determined" so the
    // user gets a hint that this entry needs follow-up.
    return "not_determined"
  }
  // `name` is one of the cheapest scriptable properties; it doesn't
  // require the app to be running (LaunchServices answers).
  let script = "tell application \"\(appName)\" to return name"
  guard let appleScript = NSAppleScript(source: script) else {
    return "not_determined"
  }
  var errInfo: NSDictionary?
  let result = appleScript.executeAndReturnError(&errInfo)
  if errInfo == nil, result.descriptorType != typeNull {
    return "granted"
  }
  // Errors we map to permission states:
  //  - -1743 = errAEEventNotPermitted (user denied / never asked)
  //  - -600 = procNotFound (app installed but not running — that's
  //    a "tell" issue, not permissions; treat as not_determined so
  //    the user re-runs with --prompt while the browser is open).
  if let code = (errInfo?[NSAppleScript.errorNumber] as? NSNumber)?.intValue {
    switch code {
    case -1743:
      return "denied"
    case -600, -10810:
      return prompt ? "not_determined" : "not_determined"
    default:
      return "not_determined"
    }
  }
  return "not_determined"
}
