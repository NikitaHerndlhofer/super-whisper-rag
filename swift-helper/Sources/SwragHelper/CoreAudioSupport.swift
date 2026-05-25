import AppKit
import CoreAudio
import Foundation

/// Mic-in-use snapshot. `owners` is the list of process bundle ids
/// that have `kAudioProcessPropertyIsRunningInput=true` right now.
/// `inUse` is `owners.count > 0` when we're running the v0.9.9
/// process-level path; on the legacy device-level fallback (macOS <
/// 14.4) it's the OR-aggregate of `kAudioDevicePropertyDeviceIsRunningSomewhere`
/// across input devices and `owners` is `[]`.
struct MicSnapshot {
  let inUse: Bool
  let owners: [String]
}

// MARK: - Device-level (legacy fallback for macOS < 14.4)

/// Enumerate all audio devices that present at least one input stream.
/// Only used by the legacy device-level fallback path on macOS <
/// 14.4. The v0.9.9 events helper subscribes to per-process audio
/// listeners directly and doesn't enumerate input devices.
func enumerateInputDevices() -> [AudioDeviceID] {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  var status = AudioObjectGetPropertyDataSize(
    AudioObjectID(kAudioObjectSystemObject),
    &addr, 0, nil, &size
  )
  guard status == noErr, size > 0 else { return [] }

  let count = Int(size) / MemoryLayout<AudioDeviceID>.size
  var devices = [AudioDeviceID](repeating: 0, count: count)
  status = devices.withUnsafeMutableBufferPointer { buf in
    AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &addr, 0, nil, &size, buf.baseAddress!
    )
  }
  guard status == noErr else { return [] }
  return devices.filter { deviceHasInputStream($0) }
}

func deviceHasInputStream(_ device: AudioDeviceID) -> Bool {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreams,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  let status = AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size)
  return status == noErr && size > 0
}

func deviceIsRunningSomewhere(_ device: AudioDeviceID) -> Bool {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  let status = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value)
  return status == noErr && value != 0
}

// MARK: - Process-level (v0.9.9, macOS 14.4+)

/// Enumerate every `AudioProcess` object the system tracks right now.
/// One per process that has registered with CoreAudio (which is every
/// process that talks to audio HAL). This is the v0.9.9 enumeration
/// primitive — it replaces the device-level enumeration used in
/// v0.9.8 and earlier.
///
/// Use `kAudioHardwarePropertyProcessObjectList` on
/// `kAudioObjectSystemObject`. The system object also exposes a
/// property listener on this address, which fires when a process
/// appears or disappears from the list — that's how the events
/// helper learns about new processes without polling.
@available(macOS 14.4, *)
func enumerateAudioProcesses() -> [AudioObjectID] {
  var listAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var listSize: UInt32 = 0
  let sizeStatus = AudioObjectGetPropertyDataSize(
    AudioObjectID(kAudioObjectSystemObject),
    &listAddr, 0, nil, &listSize
  )
  guard sizeStatus == noErr, listSize > 0 else { return [] }

  let count = Int(listSize) / MemoryLayout<AudioObjectID>.size
  var objects = [AudioObjectID](repeating: 0, count: count)
  let getStatus = objects.withUnsafeMutableBufferPointer { buf -> OSStatus in
    var ioSize = listSize
    return AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &listAddr, 0, nil, &ioSize, buf.baseAddress!
    )
  }
  guard getStatus == noErr else { return [] }
  return objects
}

/// `true` iff `kAudioProcessPropertyIsRunningInput` is set on the
/// given AudioProcess object — i.e. that specific process is using
/// the mic right now.
@available(macOS 14.4, *)
func processObjectIsRunningInput(_ obj: AudioObjectID) -> Bool {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyIsRunningInput,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  let status = AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value)
  return status == noErr && value != 0
}

/// Resolve the process object's bundle identifier directly from
/// CoreAudio via `kAudioProcessPropertyBundleID`. The property
/// returns a retained CFString; we bridge into Swift's `String` and
/// release via `takeRetainedValue()`.
///
/// Returns `nil` on error or when the property is empty. An empty
/// bundle id is real for some daemons; we treat those as anonymous
/// and skip them in the owners list.
///
/// v0.9.8 introduced bundle-id resolution through this property
/// because `NSRunningApplication(processIdentifier:)` returned nil
/// for our own recorder subprocess (it's not a GUI app), masking the
/// recorder from the owners list and breaking the recorder-mask
/// filter in the TS detector. v0.9.9 keeps the same primitive — only
/// the listener strategy changes.
@available(macOS 14.4, *)
func processObjectBundleID(_ obj: AudioObjectID) -> String? {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyBundleID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var bidPtr: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>>.size)
  let status = AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &bidPtr)
  guard status == noErr, let unmanaged = bidPtr else { return nil }
  let cf = unmanaged.takeRetainedValue()
  return cf as String
}

/// One sweep of the process list: collect the bundle ids of every
/// process that is currently running input. Deduplicated, preserving
/// first-seen order. Used by both `snapshotMic()` and the events
/// helper's re-evaluation path.
@available(macOS 14.4, *)
func currentInputRunningProcessBundleIDs() -> [String] {
  let objects = enumerateAudioProcesses()
  var bundleIds: [String] = []
  for obj in objects {
    if !processObjectIsRunningInput(obj) { continue }
    if let bid = processObjectBundleID(obj), !bid.isEmpty {
      bundleIds.append(bid)
    }
  }
  return Array(NSOrderedSet(array: bundleIds)) as? [String] ?? bundleIds
}

// MARK: - Public snapshot

/// One-shot mic snapshot. Two code paths:
///   - macOS 14.4+: enumerate AudioProcess objects, filter where
///     `IsRunningInput=true`, collect bundle ids. `inUse` derives
///     from `owners.count > 0` (any process running input means the
///     mic is in use). This matches the listener-driven path used
///     by the events helper.
///   - macOS < 14.4: legacy device-level fallback — OR-aggregate
///     `kAudioDevicePropertyDeviceIsRunningSomewhere` across input
///     devices; owners stays `[]` (no API to enumerate). The TS
///     detector handles the empty-owners case as "degraded mode"
///     and falls back to raw `inUse`.
func snapshotMic() -> MicSnapshot {
  if #available(macOS 14.4, *) {
    let owners = currentInputRunningProcessBundleIDs()
    return MicSnapshot(inUse: !owners.isEmpty, owners: owners)
  }
  let devices = enumerateInputDevices()
  let inUse = devices.contains(where: { deviceIsRunningSomewhere($0) })
  return MicSnapshot(inUse: inUse, owners: [])
}
