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

/// macOS 14.4+ exposes a process-list audio object and per-process PID,
/// giving us a credible "which app has the mic open right now" view.
/// Below 14.4 we return [] — the rest of the pipeline treats the list
/// as diagnostic, never as a confidence input.
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
    guard let pid = processObjectPID(obj) else { continue }
    // Filter to processes actually running audio right now.
    if !processObjectIsRunning(obj) { continue }
    if let app = NSRunningApplication(processIdentifier: pid),
       let bid = app.bundleIdentifier {
      bundleIds.append(bid)
    }
  }
  return Array(NSOrderedSet(array: bundleIds)) as? [String] ?? bundleIds
}

@available(macOS 14.4, *)
private func processObjectPID(_ obj: AudioObjectID) -> pid_t? {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyPID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var pid: pid_t = 0
  var size = UInt32(MemoryLayout<pid_t>.size)
  let status = AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &pid)
  return status == noErr ? pid : nil
}

@available(macOS 14.4, *)
private func processObjectIsRunning(_ obj: AudioObjectID) -> Bool {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyIsRunningInput,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  let status = AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value)
  // If `isRunningInput` isn't supported on this version, fall back to
  // including the process — the device-level OR is still authoritative.
  return status != noErr || value != 0
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
