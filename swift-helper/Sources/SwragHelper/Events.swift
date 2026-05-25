import AppKit
import CoreAudio
import Foundation

// Long-running subscriber. On launch we emit one `snapshot` event so
// the TS daemon doesn't have to call `frontmost-app` + `mic-in-use`
// separately to bootstrap state. After that we subscribe to:
//
//   - NSWorkspace.shared.notificationCenter for app activation /
//     launch / termination events.
//
//   - On macOS 14.4+ (the v0.9.9 process-level path):
//       · `kAudioHardwarePropertyProcessObjectList` on
//         `kAudioObjectSystemObject` — fires when a process appears
//         in or disappears from CoreAudio's audio-process list.
//       · Per-AudioProcess `kAudioProcessPropertyIsRunning` listeners
//         — one per known process. Fires whenever that specific
//         process toggles between "using any audio" and "not using
//         any audio". This is our wakeup signal — see the macOS API
//         note below for why we don't use `IsRunningInput` directly.
//     On any listener fire, we re-enumerate every known AudioProcess,
//     filter by `kAudioProcessPropertyIsRunningInput=true`, and
//     compute the new `owners` list. The `mic_changed` event is
//     emitted only when `(in_use, owners)` actually differs from the
//     last snapshot — so spurious `IsRunning` fires for output-only
//     processes (Spotify starts playing) cost a re-enumeration but
//     not an emitted event.
//
//     This is the v0.9.9 change. The device-level
//     `kAudioDevicePropertyDeviceIsRunningSomewhere` listener used in
//     v0.9.8 and earlier was a boolean OR across all input streams
//     and fired only when the overall device usage toggled — never
//     when the SET of mic-using processes changed while the
//     aggregate stayed `true`. That blind spot was the root cause of
//     the "stop notification doesn't fire when the meeting ends
//     during recording" bug: once our recorder joined the mic, the
//     aggregate stayed true even after the meeting app released, so
//     we never got an event with the new (recorder-only) owners list
//     and the HIGH → NONE transition was masked.
//
//     macOS API note (verified empirically on macOS Tahoe 26 during
//     v0.9.9 development): `kAudioProcessPropertyIsRunningInput`
//     property *reads* return the correct value, but listener
//     callbacks on that selector NEVER fire when the value changes
//     mid-process-lifetime. The same is true for
//     `kAudioProcessPropertyDevices`. Only
//     `kAudioProcessPropertyIsRunning` (the "running any audio"
//     aggregate) reliably fires its listener callback on transitions.
//     That's good enough for our purposes: when the meeting app
//     releases the mic — the canonical bug scenario — its
//     `IsRunning` aggregate also flips (closing the tab kills both
//     input and output sessions for that tab) and our listener fires.
//
//   - On macOS < 14.4: legacy device-level fallback —
//     `kAudioDevicePropertyDeviceIsRunningSomewhere` per input device
//     plus `kAudioHardwarePropertyDevices` for hot-plug. Owners are
//     always `[]` because `kAudioProcessProperty*` is gated to 14.4+.
//     The TS detector handles this as "degraded mode" — same
//     behaviour as the v0.9.7 fallback.
//
// All events are JSON objects on one line each, written to stdout.
// On SIGTERM/SIGINT we unregister listeners, flush stdout, exit 0.

private final class EventsRunner {
  // Common state.
  private lazy var workspaceObservers: [NSObjectProtocol] = []
  private var lastMicSnapshot: MicSnapshot = MicSnapshot(inUse: false, owners: [])
  private let queue = DispatchQueue(label: "swrag-helper.events")

  // Process-level state (macOS 14.4+).
  // The same block instance is reused for every per-process subscription
  // and for the process-list listener, because CoreAudio matches
  // listeners by (objectId, address, block-identity) — so we need
  // stable block references for clean Remove calls at shutdown.
  private var processIsRunningListeners:
    [AudioObjectID: AudioObjectPropertyListenerBlock] = [:]
  private var processListListenerInstalled = false
  // These two blocks are only ever registered on macOS 14.4+ via
  // `registerProcessListListener()` / `rebuildPerProcessListeners()`,
  // both of which carry the availability guard. The closure body
  // still needs an explicit `#available` because property
  // initialisers don't inherit the enclosing call site's availability.
  private lazy var processListListenerBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
    DispatchQueue.main.async {
      if #available(macOS 14.4, *) {
        self?.rebuildPerProcessListenersAfterListChange()
      }
    }
  }
  private lazy var processIsRunningBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
    DispatchQueue.main.async { self?.handleMicMaybeChanged() }
  }

  // Legacy device-level state (macOS < 14.4 fallback).
  private var deviceListeners: [(
    device: AudioDeviceID,
    addr: AudioObjectPropertyAddress,
    block: AudioObjectPropertyListenerBlock
  )] = []
  private var hardwareDevicesListenerInstalled = false
  private lazy var hardwareDevicesListenerBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
    DispatchQueue.main.async {
      self?.rebuildDeviceListenersAfterHotplug()
    }
  }

  func start() {
    emitSnapshot()
    subscribeWorkspace()
    subscribeCoreAudio()
    installSignalHandlers()
    // Run forever; signal handler calls exit(0).
    RunLoop.main.run()
  }

  // MARK: - Snapshot

  private func emitSnapshot() {
    let front = snapshotFrontmostApp()
    let mic = snapshotMic()
    lastMicSnapshot = mic
    let payload = SnapshotEvent(
      event: "snapshot",
      frontmost: .init(
        bundleId: front.bundleId,
        name: front.name,
        pid: front.pid
      ),
      mic: .init(inUse: mic.inUse, owners: mic.owners),
      runningCallApps: .init(strict: front.runningCallApps.strict, soft: front.runningCallApps.soft)
    )
    printJSON(payload)
  }

  // MARK: - NSWorkspace

  private func subscribeWorkspace() {
    let nc = NSWorkspace.shared.notificationCenter
    let activate = nc.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil, queue: .main
    ) { [weak self] note in self?.handleActivate(note) }
    let launch = nc.addObserver(
      forName: NSWorkspace.didLaunchApplicationNotification,
      object: nil, queue: .main
    ) { [weak self] note in self?.handleLaunch(note) }
    let terminate = nc.addObserver(
      forName: NSWorkspace.didTerminateApplicationNotification,
      object: nil, queue: .main
    ) { [weak self] note in self?.handleTerminate(note) }
    workspaceObservers = [activate, launch, terminate]
  }

  private func handleActivate(_ note: Notification) {
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
      return
    }
    printJSON(AppEvent(
      event: "frontmost_changed",
      bundleId: app.bundleIdentifier,
      name: app.localizedName,
      pid: app.processIdentifier
    ))
  }

  private func handleLaunch(_ note: Notification) {
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
      return
    }
    printJSON(AppEvent(
      event: "app_launched",
      bundleId: app.bundleIdentifier,
      name: app.localizedName,
      pid: app.processIdentifier
    ))
  }

  private func handleTerminate(_ note: Notification) {
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
      return
    }
    printJSON(AppEvent(
      event: "app_terminated",
      bundleId: app.bundleIdentifier,
      name: app.localizedName,
      pid: app.processIdentifier
    ))
  }

  // MARK: - CoreAudio entry

  private func subscribeCoreAudio() {
    if #available(macOS 14.4, *) {
      registerProcessListListener()
      rebuildPerProcessListeners()
    } else {
      registerDeviceListeners()
      registerHardwareDevicesListener()
    }
  }

  // MARK: - CoreAudio: process-level (macOS 14.4+)

  @available(macOS 14.4, *)
  private func registerProcessListListener() {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectAddPropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject),
      &addr, nil, processListListenerBlock
    )
    processListListenerInstalled = status == noErr
  }

  @available(macOS 14.4, *)
  private func unregisterProcessListListener() {
    guard processListListenerInstalled else { return }
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectRemovePropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject),
      &addr, nil, processListListenerBlock
    )
    processListListenerInstalled = false
  }

  /// Walk the current process-object list and reconcile it against
  /// our subscription set: add `IsRunning` listeners for any
  /// newly-seen objects, remove listeners for objects that no longer
  /// appear. Called once at startup and again from the process-list
  /// listener whenever a process appears or disappears.
  ///
  /// We listen on `kAudioProcessPropertyIsRunning` rather than
  /// `kAudioProcessPropertyIsRunningInput` because empirical testing
  /// on macOS Tahoe 26 (v0.9.9 dev) confirmed that the `IsRunningInput`
  /// listener never fires on state changes — only the
  /// `IsRunning` (aggregate input-or-output) listener does. We still
  /// USE `IsRunningInput` when computing the owners list — the
  /// property read returns the correct value, only the change
  /// notifications are silent. See the file-level comment for the
  /// full story.
  @available(macOS 14.4, *)
  private func rebuildPerProcessListeners() {
    let current = Set(enumerateAudioProcesses())
    let known = Set(processIsRunningListeners.keys)

    let toAdd = current.subtracting(known)
    let toRemove = known.subtracting(current)

    for obj in toAdd {
      var addr = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyIsRunning,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      let status = AudioObjectAddPropertyListenerBlock(
        obj, &addr, nil, processIsRunningBlock
      )
      if status == noErr {
        processIsRunningListeners[obj] = processIsRunningBlock
      }
    }

    for obj in toRemove {
      guard let block = processIsRunningListeners[obj] else { continue }
      var addr = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyIsRunning,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      _ = AudioObjectRemovePropertyListenerBlock(obj, &addr, nil, block)
      processIsRunningListeners.removeValue(forKey: obj)
    }
  }

  @available(macOS 14.4, *)
  private func rebuildPerProcessListenersAfterListChange() {
    rebuildPerProcessListeners()
    // The process-list change itself may have been caused by a
    // process that opened the mic on startup (so we missed the
    // IsRunning=true edge that fired before we'd registered the
    // listener) or by a process exiting while holding the mic
    // (no IsRunning=false edge — the object just vanished).
    // Either way the owners set has shifted; re-evaluate.
    handleMicMaybeChanged()
  }

  @available(macOS 14.4, *)
  private func unregisterAllPerProcessListeners() {
    for (obj, block) in processIsRunningListeners {
      var addr = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyIsRunning,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      _ = AudioObjectRemovePropertyListenerBlock(obj, &addr, nil, block)
    }
    processIsRunningListeners.removeAll()
  }

  // MARK: - CoreAudio: device-level (macOS < 14.4 fallback)

  private func registerDeviceListeners() {
    let devices = enumerateInputDevices()
    for device in devices {
      var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        DispatchQueue.main.async { self?.handleMicMaybeChanged() }
      }
      let status = AudioObjectAddPropertyListenerBlock(device, &addr, nil, block)
      if status == noErr {
        deviceListeners.append((device, addr, block))
      }
    }
  }

  private func registerHardwareDevicesListener() {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectAddPropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject),
      &addr, nil, hardwareDevicesListenerBlock
    )
    hardwareDevicesListenerInstalled = status == noErr
  }

  private func unregisterDeviceListeners() {
    for entry in deviceListeners {
      var addr = entry.addr
      _ = AudioObjectRemovePropertyListenerBlock(entry.device, &addr, nil, entry.block)
    }
    deviceListeners.removeAll()
  }

  private func unregisterHardwareDevicesListener() {
    guard hardwareDevicesListenerInstalled else { return }
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectRemovePropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject),
      &addr, nil, hardwareDevicesListenerBlock
    )
    hardwareDevicesListenerInstalled = false
  }

  private func rebuildDeviceListenersAfterHotplug() {
    unregisterDeviceListeners()
    registerDeviceListeners()
    // After a hot-plug the OR-aggregate may have flipped; re-emit if so.
    handleMicMaybeChanged()
  }

  // MARK: - Mic change emission

  private func handleMicMaybeChanged() {
    let snap = snapshotMic()
    // De-dup: only emit when state actually changes. On the v0.9.9
    // process-level path the owners list is the load-bearing signal —
    // a process flipping `IsRunningInput` mid-call (e.g. Meet tab
    // closes while we're still holding the mic) keeps `inUse=true`
    // but mutates `owners`, and we MUST emit that change so the TS
    // detector can see the new owners set and apply its recorder
    // filter. Comparing the owners list as part of the de-dup gate
    // covers that case.
    if snap.inUse == lastMicSnapshot.inUse && snap.owners == lastMicSnapshot.owners {
      return
    }
    lastMicSnapshot = snap
    printJSON(MicEvent(event: "mic_changed", inUse: snap.inUse, owners: snap.owners))
  }

  // MARK: - Signal handling

  private func installSignalHandlers() {
    // SIGTERM and SIGINT both shut us down cleanly. We bypass
    // Foundation's signal() shim (default exits non-zero) so the TS
    // daemon's process management gets exit-code 0 on graceful stop.
    let sigsrc1 = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let sigsrc2 = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigsrc1.setEventHandler { [weak self] in self?.shutdown() }
    sigsrc2.setEventHandler { [weak self] in self?.shutdown() }
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    sigsrc1.resume()
    sigsrc2.resume()
    // Retain so they aren't released before the run loop starts.
    self.signalSources = [sigsrc1, sigsrc2]
  }

  // Strong references for the dispatch sources installed above.
  private var signalSources: [DispatchSourceSignal] = []

  private func shutdown() {
    if #available(macOS 14.4, *) {
      unregisterAllPerProcessListeners()
      unregisterProcessListListener()
    }
    unregisterDeviceListeners()
    unregisterHardwareDevicesListener()
    for obs in workspaceObservers {
      NSWorkspace.shared.notificationCenter.removeObserver(obs)
    }
    workspaceObservers.removeAll()
    fflush(stdout)
    exit(0)
  }
}

// MARK: - Event payloads

private struct SnapshotEvent: Codable {
  let event: String
  let frontmost: Frontmost
  let mic: Mic
  let runningCallApps: RunningCallApps

  struct Frontmost: Codable {
    let bundleId: String?
    let name: String?
    let pid: Int32?
  }
  struct Mic: Codable {
    let inUse: Bool
    let owners: [String]

    enum CodingKeys: String, CodingKey {
      case inUse = "in_use"
      case owners
    }
  }
  struct RunningCallApps: Codable {
    let strict: [String]
    let soft: [String]
  }

  enum CodingKeys: String, CodingKey {
    case event
    case frontmost
    case mic
    case runningCallApps = "running_call_apps"
  }
}

private struct AppEvent: Codable {
  let event: String
  let bundleId: String?
  let name: String?
  let pid: Int32?

  enum CodingKeys: String, CodingKey {
    case event
    case bundleId = "bundle_id"
    case name
    case pid
  }
}

private struct MicEvent: Codable {
  let event: String
  let inUse: Bool
  let owners: [String]

  enum CodingKeys: String, CodingKey {
    case event
    case inUse = "in_use"
    case owners
  }
}

// MARK: - Entry

func runEvents() {
  let runner = EventsRunner()
  runner.start()
}
