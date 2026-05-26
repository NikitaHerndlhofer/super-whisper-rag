import AppKit
import Foundation

/// Global keyboard-shortcut monitor used by the menubar's `record_stop`
/// hotkey (v0.9.11).
///
/// Backed by `NSEvent.addGlobalMonitorForEvents(matching: .keyDown,
/// handler:)`. The "global" variant fires on EVERY system-wide key
/// event regardless of which app is frontmost — exactly what we want
/// for an accessory-policy menubar process that never receives the
/// focus the local variant would require.
///
/// Caveats inherited from `addGlobalMonitorForEvents`:
///   * Requires Accessibility permission. Without it the system
///     silently never invokes the handler — no error, no fall-back.
///     `PermissionsCheck.swift` surfaces the grant state so the user
///     can tell from `swrag meeting permissions-check` whether their
///     hotkey will actually fire.
///   * Cannot consume the event. The keystroke still reaches the
///     frontmost app. For our stop-recording use case that's fine.
///   * Apple recommends pairing with `addLocalMonitorForEvents` for
///     the case where the menubar itself is frontmost. We don't
///     bother: a launchd-spawned NSStatusItem with
///     activationPolicy=.accessory is never the frontmost responder.
///
/// Lifecycle:
///   * `install(combo:onFire:)` registers the monitor. Idempotent —
///     replacing an existing combo first removes the prior monitor.
///   * `remove()` deregisters and is also called on every install.
///   * Both are main-thread-only (AppKit constraint).
///
/// The monitor object returned by `addGlobalMonitorForEvents` is an
/// opaque `Any?`; we retain it and pass it back to
/// `removeMonitor` on cleanup. Without an explicit removal the
/// system would keep the closure alive for the life of the process
/// and continue firing it after the user disabled the hotkey.
final class HotkeyMonitor {
  private var monitorToken: Any?
  private var installedCombo: HotkeyCombo?

  func install(combo: HotkeyCombo, onFire: @escaping () -> Void) {
    remove()
    let token = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
      // Mask off mouse/caps/numpad/etc flags so the comparison is on
      // the user-meaningful modifiers only. Without `intersection`
      // we'd see flags like `.deviceIndependentFlagsMask` itself
      // leak in on some keyboard configurations.
      let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      // Strip the small set of flags AppKit attaches to every event
      // regardless of physical modifier state (.function for arrow
      // keys, .numericPad for some keyboards). We compare against
      // exactly the modifiers the user listed.
      let effective = mods.intersection(
        [.command, .shift, .control, .option]
      )
      if event.keyCode == combo.keyCode && effective == combo.modifiers {
        onFire()
      }
    }
    self.monitorToken = token
    self.installedCombo = combo
  }

  func remove() {
    if let token = monitorToken {
      NSEvent.removeMonitor(token)
      monitorToken = nil
    }
    installedCombo = nil
  }

  var current: HotkeyCombo? { installedCombo }
}

/// Parsed representation of a user-configured shortcut string
/// (e.g. `"cmd+shift+s"` → `.command + .shift`, keyCode 1).
struct HotkeyCombo: Equatable {
  let modifiers: NSEvent.ModifierFlags
  let keyCode: UInt16
  /// Verbatim normalised form (lowercased, whitespace-stripped) — the
  /// menubar uses this to detect "user changed the hotkey config"
  /// without re-parsing every push event.
  let canonical: String

  /// Parse a shortcut string. Returns nil on any failure (unknown
  /// modifier name, unknown key name, empty input). Format:
  ///   `[modifier+]…+key`
  /// where modifier ∈ {cmd, command, shift, ctrl, control, alt, opt, option}
  /// and key ∈ {a–z, 0–9, space, return, enter, tab, escape, esc, f1–f12}.
  /// Case-insensitive; whitespace around `+` is tolerated.
  static func parse(_ raw: String) -> HotkeyCombo? {
    let trimmed = raw.trimmingCharacters(in: .whitespaces).lowercased()
    if trimmed.isEmpty { return nil }
    let parts = trimmed
      .split(separator: "+")
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    if parts.isEmpty { return nil }
    var mods: NSEvent.ModifierFlags = []
    var keyToken: String?
    for (idx, p) in parts.enumerated() {
      let isLast = idx == parts.count - 1
      switch p {
      case "cmd", "command":
        mods.insert(.command)
      case "shift":
        mods.insert(.shift)
      case "ctrl", "control":
        mods.insert(.control)
      case "alt", "opt", "option":
        mods.insert(.option)
      default:
        // Anything that doesn't match a known modifier name must be
        // the key — and the key must be the last token. If a
        // non-modifier appears mid-string the input is malformed.
        if !isLast { return nil }
        keyToken = p
      }
    }
    guard let key = keyToken, let code = keyCodeFor(key) else { return nil }
    // Canonicalise: modifiers sorted, then the key. We sort by the
    // raw value so the string is stable across parses.
    var canonicalParts: [String] = []
    if mods.contains(.control) { canonicalParts.append("ctrl") }
    if mods.contains(.option) { canonicalParts.append("alt") }
    if mods.contains(.shift) { canonicalParts.append("shift") }
    if mods.contains(.command) { canonicalParts.append("cmd") }
    canonicalParts.append(key)
    let canonical = canonicalParts.joined(separator: "+")
    return HotkeyCombo(modifiers: mods, keyCode: code, canonical: canonical)
  }
}

/// US-ANSI virtual key codes for the small set of keys we support in
/// the hotkey config string. Sourced from `Events.h` (Carbon) — these
/// constants are stable across macOS versions and don't depend on the
/// current keyboard layout (which is what we want for a hotkey: the
/// user types `cmd+shift+s` meaning "the physical key labeled S on
/// the ANSI layout", not "whatever produces an `s` on a Dvorak
/// keyboard").
private let HOTKEY_KEY_CODES: [String: UInt16] = [
  // letters
  "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
  "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
  "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
  "y": 16, "z": 6,
  // digits (top row, not numpad)
  "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
  "7": 26, "8": 28, "9": 25,
  // common named keys
  "space": 49, "return": 36, "enter": 36, "tab": 48,
  "escape": 53, "esc": 53,
  // function keys
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

private func keyCodeFor(_ name: String) -> UInt16? {
  HOTKEY_KEY_CODES[name]
}
