import Foundation

struct MicInUsePayload: Codable {
  let inUse: Bool
  let owners: [String]
}

func runMicInUse() {
  let snap = snapshotMic()
  let payload = MicInUsePayload(inUse: snap.inUse, owners: snap.owners)
  printJSON(payload)
  exit(0)
}
