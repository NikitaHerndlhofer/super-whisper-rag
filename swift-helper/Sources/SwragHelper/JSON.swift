import Foundation

/// Encode `value` as compact JSON and write it to stdout followed by a
/// newline. The TS daemon parses stdout line-by-line, so emitting a
/// trailing `\n` per object is the framing protocol.
///
/// We use ISO-8601 dates and `.sortedKeys` for output stability —
/// makes diffing helper output easier and tests less fragile.
func printJSON<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  do {
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    let msg = "json encode error: \(error)\n"
    FileHandle.standardError.write(Data(msg.utf8))
    exit(1)
  }
}
