import Foundation
import Network

/// Thin wrapper around `NWConnection` for the meeting daemon's unix
/// socket. Speaks line-delimited JSON: every message is one Encodable
/// payload terminated with a `\n`, every received message is one JSON
/// object terminated with a `\n`.
///
/// The daemon supports two patterns:
///   - Request / response: send one op, read one line, close.
///   - Subscription: send `subscribe`, keep open, receive a stream of
///     event objects pushed by the daemon.
///
/// `DaemonClient` is connection-oriented — caller manages whether to
/// open a fresh connection per one-shot op or to keep one alive for
/// subscription. The menu bar uses one persistent subscriber +
/// per-op fresh connections (simpler than multiplexing).
///
/// Reconnect / backoff lives in the caller (`MenuBar.swift`) so the
/// connection itself stays a thin transport. That keeps testing
/// concerns (which we won't author for Swift in Phase 4) tractable
/// in the future and matches the responsibility split on the TS
/// side.
final class DaemonConnection {
  enum State {
    case idle
    case connecting
    case ready
    case failed(Error)
    case closed
  }

  private let socketPath: String
  private let queue: DispatchQueue
  private var connection: NWConnection?
  private(set) var state: State = .idle
  /// Incoming bytes that haven't been split into a complete line yet.
  /// We accumulate raw `Data` rather than decoding immediately because
  /// a UTF-8 codepoint could be split across two `receive` callbacks.
  private var receiveBuffer = Data()

  /// Called for every full JSON line received from the daemon. Errors
  /// from decoding are surfaced via `onError` so the menu bar can
  /// reconnect or surface a "daemon protocol error" to the user.
  var onLine: ((Data) -> Void)?
  var onStateChange: ((State) -> Void)?
  var onError: ((Error) -> Void)?

  init(socketPath: String, queue: DispatchQueue = DispatchQueue(label: "swrag-menubar.daemon")) {
    self.socketPath = socketPath
    self.queue = queue
  }

  func connect() {
    state = .connecting
    onStateChange?(state)
    let endpoint = NWEndpoint.unix(path: socketPath)
    // `.tcp` here is the framing parameter — unix-domain stream
    // sockets in NWConnection map to the TCP parameters set; UDP
    // would be `.udp`. We want stream semantics.
    let conn = NWConnection(to: endpoint, using: .tcp)
    self.connection = conn
    conn.stateUpdateHandler = { [weak self] newState in
      guard let self = self else { return }
      switch newState {
      case .ready:
        self.state = .ready
        self.onStateChange?(self.state)
        self.startReceiveLoop()
      case .failed(let err):
        self.state = .failed(err)
        self.onStateChange?(self.state)
        self.onError?(err)
      case .cancelled:
        self.state = .closed
        self.onStateChange?(self.state)
      default:
        break
      }
    }
    conn.start(queue: queue)
  }

  func send(_ payload: Encodable) {
    guard let conn = connection else { return }
    do {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      var data = try encoder.encode(AnyEncodable(payload))
      data.append(Data("\n".utf8))
      conn.send(
        content: data,
        completion: .contentProcessed { [weak self] err in
          if let err = err {
            self?.onError?(err)
          }
        }
      )
    } catch {
      onError?(error)
    }
  }

  /// Send the raw JSON-encoded form of `op`. Use this for ops whose
  /// shape is built outside of the Codable surface — e.g. menu-item
  /// dispatch where the op identifier lives in a string.
  func sendRawJSON(_ json: [String: Any]) {
    guard let conn = connection else { return }
    do {
      var data = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
      data.append(Data("\n".utf8))
      conn.send(
        content: data,
        completion: .contentProcessed { [weak self] err in
          if let err = err {
            self?.onError?(err)
          }
        }
      )
    } catch {
      onError?(error)
    }
  }

  func cancel() {
    connection?.cancel()
    connection = nil
    state = .closed
    onStateChange?(state)
  }

  private func startReceiveLoop() {
    guard let conn = connection else { return }
    conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, err in
      guard let self = self else { return }
      if let err = err {
        self.onError?(err)
        return
      }
      if let data = data, !data.isEmpty {
        self.receiveBuffer.append(data)
        self.drainLines()
      }
      if isComplete {
        self.state = .closed
        self.onStateChange?(self.state)
        return
      }
      // Continue the receive loop. NWConnection delivers one receive
      // at a time; we have to re-arm after each callback.
      self.startReceiveLoop()
    }
  }

  private func drainLines() {
    let newline: UInt8 = 0x0A
    while let idx = receiveBuffer.firstIndex(of: newline) {
      let lineData = receiveBuffer.subdata(in: receiveBuffer.startIndex..<idx)
      // Advance past the newline. firstIndex is the index of the
      // newline byte in the buffer; we slice [startIndex..<idx],
      // then keep [(idx+1)..<endIndex] for the next iteration.
      let next = receiveBuffer.index(after: idx)
      receiveBuffer.removeSubrange(receiveBuffer.startIndex..<next)
      if !lineData.isEmpty {
        onLine?(lineData)
      }
    }
  }
}

/// Type-erasing wrapper so we can pass any `Encodable` payload
/// through one JSONEncoder call site.
struct AnyEncodable: Encodable {
  let value: Encodable
  init(_ value: Encodable) { self.value = value }
  func encode(to encoder: Encoder) throws {
    try value.encode(to: encoder)
  }
}
