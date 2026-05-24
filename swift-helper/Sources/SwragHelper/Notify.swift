import AppKit
import Foundation
import UserNotifications

/// `swrag-helper notify` — post a single banner notification via
/// `UNUserNotificationCenter` with optional action buttons.
///
/// Stdout protocol:
///   * On action click  → print the action identifier lowercased, exit 0.
///   * On body click    → print the `--default-action` value lowercased, exit 0.
///   * On timer expiry  → print `timeout`, exit 0.
///   * On auth denied   → write diagnostic to stderr, exit non-zero.
///   * On post failure  → write diagnostic to stderr, exit non-zero.
///
/// We DO NOT request `.customDismissAction`, so swiping the banner
/// away doesn't fire a delegate callback — the only way to reach
/// the "timeout" branch is for the timer to expire (which also
/// covers banner auto-dismiss; both look like "user didn't choose").
///
/// `UNUserNotificationCenter` requires the executable to live inside
/// a code-signed .app bundle so the system can resolve a stable
/// bundle identifier. That requirement is met by the build pipeline:
/// `scripts/build-swift-helper.sh` lays the binary at
/// `vendor/swrag-helper.app/Contents/MacOS/swrag-helper`, copies the
/// `Info.plist`, and ad-hoc-signs the whole bundle. Running the
/// inner binary directly (e.g. via Bun.spawn) still resolves the
/// bundle context because Foundation walks up looking for the
/// `.app/Contents/MacOS/<exe>` pattern.

private final class NotifyDelegate: NSObject, UNUserNotificationCenterDelegate {
  fileprivate var chosenActionIdentifier: String?

  // Show the alert even if the helper happens to be foregrounded
  // (it never is, with LSUIElement=true, but belt-and-braces).
  func userNotificationCenter(
    _: UNUserNotificationCenter,
    willPresent _: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    chosenActionIdentifier = response.actionIdentifier
    completionHandler()
    CFRunLoopStop(CFRunLoopGetMain())
  }
}

private struct NotifyArgs {
  var title: String = ""
  var body: String = ""
  var actions: [String] = []
  var defaultAction: String = ""
  var timeoutSec: Double = 90
}

private func parseNotifyArgs(_ args: [String]) -> NotifyArgs {
  var out = NotifyArgs()
  var i = 0
  while i < args.count {
    let flag = args[i]
    let next: String? = (i + 1 < args.count) ? args[i + 1] : nil
    switch flag {
    case "--title":
      if let v = next { out.title = v; i += 2 } else { i += 1 }
    case "--body":
      if let v = next { out.body = v; i += 2 } else { i += 1 }
    case "--actions":
      if let v = next {
        out.actions = v
          .split(separator: ",", omittingEmptySubsequences: true)
          .map { $0.trimmingCharacters(in: .whitespaces) }
          .filter { !$0.isEmpty }
        i += 2
      } else {
        i += 1
      }
    case "--default-action":
      if let v = next { out.defaultAction = v; i += 2 } else { i += 1 }
    case "--timeout":
      if let v = next, let secs = Double(v), secs > 0 {
        out.timeoutSec = secs
        i += 2
      } else {
        i += 1
      }
    default:
      i += 1
    }
  }
  return out
}

func runNotify(args: [String]) {
  let parsed = parseNotifyArgs(args)
  if parsed.title.isEmpty && parsed.body.isEmpty {
    FileHandle.standardError.write(Data("notify: --title or --body required\n".utf8))
    exit(2)
  }

  // Background app: no Dock icon, no menu bar takeover. Without this,
  // the helper would briefly appear in the Dock when the run loop
  // starts.
  NSApplication.shared.setActivationPolicy(.accessory)

  let center = UNUserNotificationCenter.current()
  // Delegate must outlive the notification dispatch. CFRunLoopRun
  // owns the only strong reference until we stop it; keep it on the
  // stack so ARC doesn't drop the delegate prematurely.
  let delegate = NotifyDelegate()
  center.delegate = delegate

  // Authorization. We DO NOT call `requestAuthorization` from this
  // subcommand: it would synchronously block on a user-facing system
  // prompt with no upper bound on how long the user takes to click.
  // The daemon's caller can't recover from that (it `await`s the
  // helper exit), so the path would deadlock the whole popup
  // pipeline on first run.
  //
  // Instead, we treat notify as "fire if we already have permission":
  //   * `.authorized` / `.provisional` → post the notification.
  //   * `.denied` / `.notDetermined` → exit non-zero with a clear
  //     stderr message; the caller falls back / logs.
  //
  // The explicit grant flow is `swrag-helper permissions-check
  // --prompt`, which IS user-initiated and CAN block on the dialog.
  let settingsSem = DispatchSemaphore(value: 0)
  var authStatus: UNAuthorizationStatus = .notDetermined
  center.getNotificationSettings { settings in
    authStatus = settings.authorizationStatus
    settingsSem.signal()
  }
  settingsSem.wait()

  switch authStatus {
  case .authorized, .provisional, .ephemeral:
    break
  case .notDetermined:
    let msg = "notify: notification authorization not yet decided. "
      + "Run `swrag meeting permissions-check --prompt` to grant.\n"
    FileHandle.standardError.write(Data(msg.utf8))
    exit(4)
  case .denied:
    let msg = "notify: notification authorization denied. "
      + "Grant in System Settings → Notifications → swrag-helper.\n"
    FileHandle.standardError.write(Data(msg.utf8))
    exit(4)
  @unknown default:
    FileHandle.standardError.write(
      Data("notify: unknown authorization status \(authStatus.rawValue)\n".utf8)
    )
    exit(4)
  }

  // Build category with action buttons. Identifiers double as
  // stdout payloads — we want them readable downstream, so we keep
  // the caller's casing and lowercase on the way out.
  let categoryId = "ai.swrag.helper.notify"
  let unActions: [UNNotificationAction] = parsed.actions.map { name in
    UNNotificationAction(
      identifier: name,
      title: name,
      options: [.foreground]
    )
  }
  let category = UNNotificationCategory(
    identifier: categoryId,
    actions: unActions,
    intentIdentifiers: [],
    options: []
  )
  center.setNotificationCategories([category])

  // Build + post content.
  let content = UNMutableNotificationContent()
  content.title = parsed.title
  content.body = parsed.body
  content.categoryIdentifier = categoryId
  content.sound = .default

  let request = UNNotificationRequest(
    identifier: UUID().uuidString,
    content: content,
    trigger: nil
  )
  let postSem = DispatchSemaphore(value: 0)
  var postError: Error?
  center.add(request) { error in
    postError = error
    postSem.signal()
  }
  postSem.wait()
  if let err = postError {
    FileHandle.standardError.write(
      Data("notify: post error: \(err.localizedDescription)\n".utf8)
    )
    exit(5)
  }

  // Timeout: schedule a one-shot timer that stops the run loop. Any
  // delegate callback also stops the loop. Whichever fires first wins.
  let timer = DispatchSource.makeTimerSource(queue: .main)
  timer.schedule(deadline: .now() + parsed.timeoutSec)
  timer.setEventHandler {
    CFRunLoopStop(CFRunLoopGetMain())
  }
  timer.resume()

  CFRunLoopRun()
  timer.cancel()

  // Decide what to print. We map:
  //   - explicit action button click → its identifier (lowercased)
  //   - body click (UNNotificationDefaultActionIdentifier) → the
  //     caller's --default-action (lowercased)
  //   - dismiss / no callback → "timeout"
  let chosen = delegate.chosenActionIdentifier
  let payload: String
  switch chosen {
  case nil:
    payload = "timeout"
  case let value? where value == UNNotificationDefaultActionIdentifier:
    payload = parsed.defaultAction.isEmpty
      ? "timeout"
      : parsed.defaultAction.lowercased()
  case let value? where value == UNNotificationDismissActionIdentifier:
    payload = "timeout"
  case let value?:
    payload = value.lowercased()
  }
  print(payload)
  exit(0)
}

/// Probe notification authorization state without firing a prompt.
/// Returns one of "granted" / "denied" / "not_determined" /
/// "provisional".
///
/// Synchronous wrapper around the async getter — uses a semaphore so
/// it composes with the other probes in PermissionsCheck.swift.
func probeNotificationAuthorization() -> String {
  let center = UNUserNotificationCenter.current()
  let sem = DispatchSemaphore(value: 0)
  var status: UNAuthorizationStatus = .notDetermined
  center.getNotificationSettings { settings in
    status = settings.authorizationStatus
    sem.signal()
  }
  sem.wait()
  switch status {
  case .authorized: return "granted"
  case .denied: return "denied"
  case .notDetermined: return "not_determined"
  case .provisional: return "provisional"
  case .ephemeral: return "provisional"
  @unknown default: return "not_determined"
  }
}

/// Prompt for notification authorization. Returns the (possibly
/// updated) state after the prompt closes. Used by
/// `permissions-check --prompt`.
func promptNotificationAuthorization() -> String {
  let center = UNUserNotificationCenter.current()
  let sem = DispatchSemaphore(value: 0)
  center.requestAuthorization(options: [.alert, .sound]) { _, _ in
    sem.signal()
  }
  sem.wait()
  return probeNotificationAuthorization()
}
