import AppKit
import Foundation
import UserNotifications

/// `swrag-helper notify` — post a single banner notification via
/// `UNUserNotificationCenter` with optional action buttons.
///
/// Stdout protocol:
///   * On action click  → print the action title verbatim, exit 0.
///   * On body click    → print the `--default-action` value verbatim, exit 0.
///   * On timer expiry  → print `timeout`, exit 0.
///   * On auth denied   → write diagnostic to stderr, exit non-zero.
///   * On post failure  → write diagnostic to stderr, exit non-zero.
///
/// Each `--actions` piece is a single string used as BOTH the
/// `UNNotificationAction.title` (what the user sees on the banner)
/// AND the `UNNotificationAction.identifier` (what comes back on
/// `response.actionIdentifier`). Identifiers accept arbitrary unicode,
/// so callers can pass labels like `Stop & save` directly — there's
/// no shell-escaping concern because the TS wrapper invokes the
/// helper via `Bun.spawn` (argv array, no shell interpretation).
///
/// v0.9.6 introduced an `id=Display Label` parsing syntax to separate
/// the wire-side identifier from the display label. v0.9.7 dropped it
/// after macOS surfaced the raw `id=Label` string in the button on
/// some systems — see CHANGELOG for the full story.
///
/// We DO NOT request `.customDismissAction`, so swiping the banner
/// away doesn't fire a delegate callback — the only way to reach
/// the "timeout" branch is for the timer to expire (which also
/// covers banner auto-dismiss; both look like "user didn't choose").
///
/// On EVERY exit path (action click, body click, dismiss, timer
/// expiry) the helper yanks the notification from Notification
/// Center via `removeDeliveredNotifications` + `removePendingNotification
/// Requests` keyed by the request's UUID. v0.9.7 added this so the
/// banner doesn't linger in the tray after the user has already
/// responded — the helper-side intent is "one-shot prompt", not
/// "persistent inbox item".
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

  // Build category with action buttons. Each `--actions` piece
  // doubles as both the button title (what the user sees) and the
  // identifier (what we get back on `response.actionIdentifier`).
  // The category id is versioned with the action shape so a macOS-
  // side cached category from an older helper version can't poison
  // the rendered title — v0.9.7 bumped the suffix when dropping the
  // v0.9.6 `id=Display Label` parsing syntax.
  let categoryId = "ai.swrag.helper.notify.v2"
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

  let requestIdentifier = UUID().uuidString
  let request = UNNotificationRequest(
    identifier: requestIdentifier,
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

  // Ephemeral cleanup (v0.9.7): yank the notification from Notification
  // Center before we exit, on EVERY exit path — action click, body
  // click, dismiss, timer expiry. Without this, the banner persists in
  // Notification Center after the user has either acted on it or let
  // it time out, forcing them to dismiss it again from the tray. The
  // helper-side intent is "one-shot prompt"; the system's persistence
  // model is the wrong fit for that. Two calls, both keyed by the
  // identifier we stamped on the request:
  //   * removeDeliveredNotifications — clears the banner if the system
  //     already routed it to the user.
  //   * removePendingNotificationRequests — clears the scheduled
  //     request if a very short --timeout fires before delivery. Both
  //     calls are no-ops when their respective slot is empty, so it's
  //     safe to fire both unconditionally.
  // These calls are best-effort and async on the system side; we don't
  // wait for them because the helper is about to exit anyway and the
  // removal completes inside the daemon backing UNUserNotificationCenter
  // regardless of whether our process is still alive.
  center.removeDeliveredNotifications(withIdentifiers: [requestIdentifier])
  center.removePendingNotificationRequests(withIdentifiers: [requestIdentifier])

  // Decide what to print. We map:
  //   - explicit action button click → its identifier verbatim
  //   - body click (UNNotificationDefaultActionIdentifier) → the
  //     caller's --default-action verbatim
  //   - dismiss / no callback → "timeout"
  //
  // v0.9.7 dropped the historical `.lowercased()` normalisation: the
  // helper now echoes the action label exactly as the caller passed
  // it, so the TS-side schema literals match the user-visible button
  // text and there's no hidden casefolding step on the wire.
  let chosen = delegate.chosenActionIdentifier
  let payload: String
  switch chosen {
  case nil:
    payload = "timeout"
  case let value? where value == UNNotificationDefaultActionIdentifier:
    payload = parsed.defaultAction.isEmpty ? "timeout" : parsed.defaultAction
  case let value? where value == UNNotificationDismissActionIdentifier:
    payload = "timeout"
  case let value?:
    payload = value
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
