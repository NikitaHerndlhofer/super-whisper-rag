import AppKit
import CoreAudio
import Foundation

/// Mic-in-use snapshot computed by OR'ing `kAudioDevicePropertyDeviceIsRunningSomewhere`
/// across every input device on the system. `owners` is best-effort and may be empty
/// on macOS < 14.4 (the `kAudioProcessPropertyPID` API used to populate it is gated
/// to that OS).
struct MicSnapshot {
  let inUse: Bool
  let owners: [String]
}

/// Enumerate all audio devices that present at least one input stream.
/// Used by both the `mic-in-use` one-shot and the `events` long-running
/// subcommand (the latter registers a property listener per device).
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

/// macOS 14.4+ exposes a process-list audio object, per-process PID,
/// per-process running-input flag, and per-process bundle identifier.
/// Together they give us a credible "which app has the mic open right
/// now" view. Below 14.4 we return [] — the rest of the pipeline
/// treats the list as diagnostic, never as a confidence input.
///
/// v0.9.8: bundle ID is resolved via `kAudioProcessPropertyBundleID`
/// instead of `NSRunningApplication(processIdentifier:)`. The former
/// is what CoreAudio knows about the process directly; the latter
/// returns `nil` for any process that isn't a GUI app, which on this
/// machine includes the swrag-helper recorder subprocess itself.
/// That `nil` was the root cause of v0.9.7's empty owners list even
/// though the recorder was the active mic client — leading the
/// detector to never see a HIGH → NONE edge once we started recording,
/// and the stop-recording banner never firing.
func currentAudioClientBundleIDs() -> [String] {
  guard #available(macOS 14.4, *) else { return [] }

  var listAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var listSize: UInt32 = 0
  let listStatus = AudioObjectGetPropertyDataSize(
    AudioObjectID(kAudioObjectSystemObject),
    &listAddr, 0, nil, &listSize
  )
  guard listStatus == noErr, listSize > 0 else { return [] }

  let count = Int(listSize) / MemoryLayout<AudioObjectID>.size
  var objects = [AudioObjectID](repeating: 0, count: count)
  let getStatus = objects.withUnsafeMutableBufferPointer { buf -> OSStatus in
    var inout_size = listSize
    return AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &listAddr, 0, nil, &inout_size, buf.baseAddress!
    )
  }
  guard getStatus == noErr else { return [] }

  var bundleIds: [String] = []
  for obj in objects {
    // Filter to processes actually running audio input right now.
    if !processObjectIsRunningInput(obj) { continue }
    if let bid = processObjectBundleID(obj), !bid.isEmpty {
      bundleIds.append(bid)
    }
  }
  return Array(NSOrderedSet(array: bundleIds)) as? [String] ?? bundleIds
}

@available(macOS 14.4, *)
private func processObjectIsRunningInput(_ obj: AudioObjectID) -> Bool {
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
/// CoreAudio via `kAudioProcessPropertyBundleID`. The property returns
/// a retained CFString; we bridge into Swift's `String` and release
/// via `takeRetainedValue()`.
///
/// Returns `nil` on any error or when the property is empty. An empty
/// bundle id is real (some daemon processes have no bundle); we treat
/// those as anonymous and exclude them from the owners list.
@available(macOS 14.4, *)
private func processObjectBundleID(_ obj: AudioObjectID) -> String? {
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

/// One-shot mic snapshot. Used by both the `mic-in-use` subcommand and
/// the `events` subcommand's startup snapshot + every re-evaluation
/// triggered by a CoreAudio property listener.
func snapshotMic() -> MicSnapshot {
  let devices = enumerateInputDevices()
  let inUse = devices.contains(where: { deviceIsRunningSomewhere($0) })
  let owners = inUse ? currentAudioClientBundleIDs() : []
  return MicSnapshot(inUse: inUse, owners: owners)
}
