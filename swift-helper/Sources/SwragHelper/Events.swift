import AppKit
import CoreAudio
import Foundation

// Long-running subscriber. On launch we emit one `snapshot` event so
// the TS daemon doesn't have to call `frontmost-app` + `mic-in-use`
// separately to bootstrap state. After that we subscribe to:
//
//   - NSWorkspace.shared.notificationCenter for app activation /
//     launch / termination events.
//   - kAudioDevicePropertyDeviceIsRunningSomewhere on every input
//     device, so we know the instant a process starts or stops using
//     the mic (any input — built-in, USB, AirPods, virtual loopback).
//   - kAudioHardwarePropertyDevices system-wide, so we can tear down
//     and re-register the per-device listeners when the user plugs in
//     or removes a device mid-session.
//
// All events are JSON objects on one line each, written to stdout.
// On SIGTERM/SIGINT we unregister listeners, flush stdout, exit 0.

private final class EventsRunner {
  private var deviceListeners: [(device: AudioDeviceID, addr: AudioObjectPropertyAddress, block: AudioObjectPropertyListenerBlock)] = []
  private var hardwareListenerInstalled = false
  // Captured so we can pass the same block into Remove. CoreAudio
  // matches listeners by (objectId, address, block-identity), so we
  // can't construct a fresh block at removal time.
  private lazy var hardwareListenerBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
    // Hot-plug: input device set changed. Tear down + rebuild.
    DispatchQueue.main.async {
      self?.rebuildDeviceListenersAfterHotplug()
    }
  }

  private lazy var workspaceObservers: [NSObjectProtocol] = []
  private var lastMicSnapshot: MicSnapshot = MicSnapshot(inUse: false, owners: [])
  private let queue = DispatchQueue(label: "swrag-helper.events")

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

  // MARK: - CoreAudio

  private func subscribeCoreAudio() {
    registerDeviceListeners()
    registerHardwareListener()
  }

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

  private func registerHardwareListener() {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectAddPropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject),
      &addr, nil, hardwareListenerBlock
    )
    hardwareListenerInstalled = status == noErr
  }

  private func unregisterDeviceListeners() {
    for entry in deviceListeners {
      var addr = entry.addr
      _ = AudioObjectRemovePropertyListenerBlock(entry.device, &addr, nil, entry.block)
    }
    deviceListeners.removeAll()
  }

  private func unregisterHardwareListener() {
    guard hardwareListenerInstalled else { return }
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectRemovePropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject),
      &addr, nil, hardwareListenerBlock
    )
    hardwareListenerInstalled = false
  }

  private func rebuildDeviceListenersAfterHotplug() {
    unregisterDeviceListeners()
    registerDeviceListeners()
    // After a hot-plug the OR-aggregate may have flipped; re-emit if so.
    handleMicMaybeChanged()
  }

  private func handleMicMaybeChanged() {
    let snap = snapshotMic()
    // De-dup: only emit when state actually changes. owners is
    // best-effort and may flicker on older macOS — compare against
    // both in-use bit and owners list to be safe.
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
    unregisterDeviceListeners()
    unregisterHardwareListener()
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
