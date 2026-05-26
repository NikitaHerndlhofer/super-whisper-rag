import AppKit
import Foundation

/// `swrag-helper menubar` subcommand.
///
/// Runs as an NSStatusItem application (no Dock icon — see
/// `NSApp.setActivationPolicy(.accessory)`). Connects to the
/// daemon's unix socket, subscribes for push events, and renders a
/// menu whose contents reflect the latest daemon state.
///
/// Two connections are used:
///   - `subscriber` — long-lived; sends `subscribe` once, then
///     receives event objects pushed by the daemon as they happen.
///   - per-op one-shot connections opened inside `dispatch(op:)`
///     when the user clicks a menu item. Simpler than multiplexing
///     ops and pushes on the same wire.
///
/// On disconnect the menu shows "Daemon unavailable" and we attempt
/// to reconnect with exponential backoff (1 → 5 → 30 → 60 s).
///
/// The Phase 4 spec's state-table covers five conditional shapes
/// (paused-empty / paused-pending / processing / pausing /
/// recording-overlay) — v0.9.6 dropped the sixth (undo-window) when
/// the stop flow moved to a notification banner. We drive everything
/// off two pieces of state — the latest `status` payload + the
/// latest `queue_state` payload — and rebuild the menu on every
/// change.

private let DEFAULT_SOCKET_PATH = NSHomeDirectory()
  + "/Library/Application Support/superwhisper-rag/meeting.sock"

private struct StatusPayload: Decodable {
  let recording: Bool
  let since: String?
  let audioPath: String?
  let queuePending: Int
  /// v0.9.11: opt-in hotkey config carried on the subscribe envelope
  /// + every status response. The menubar uses
  /// `hotkeys.stop_recording` to decide whether to arm a global
  /// keyboard monitor while recording. Absent / null on installs
  /// that haven't opted in via `swrag meeting config set
  /// hotkeys.stop_recording …`.
  let hotkeys: HotkeysPayload?

  enum CodingKeys: String, CodingKey {
    case recording
    case since
    case audioPath = "audio_path"
    case queuePending = "queue_pending"
    case hotkeys
  }
}

private struct HotkeysPayload: Decodable {
  let stopRecording: String?

  enum CodingKeys: String, CodingKey {
    case stopRecording = "stop_recording"
  }
}

private struct ConfigReloadedEnvelope: Decodable {
  let event: String
  let config: ConfigPayload?

  struct ConfigPayload: Decodable {
    let hotkeys: HotkeysPayload?
  }
}

private struct QueueStatePayload: Decodable {
  let state: String
  let currentItem: QueueItem?
  let batchPosition: Int?
  let batchSize: Int?

  struct QueueItem: Decodable {
    let id: Int
    let capturedAt: String
    let label: String?
    let durationMs: Int?
    let status: String

    enum CodingKeys: String, CodingKey {
      case id
      case capturedAt = "captured_at"
      case label
      case durationMs = "duration_ms"
      case status
    }
  }

  enum CodingKeys: String, CodingKey {
    case state
    case currentItem = "current_item"
    case batchPosition = "batch_position"
    case batchSize = "batch_size"
  }
}

private struct QueueListPayload: Decodable {
  let items: [QueueStatePayload.QueueItem]
}

private struct SubscribedEnvelope: Decodable {
  let event: String
  let status: StatusPayload?
}

private final class MenuBarController: NSObject {
  private let statusItem: NSStatusItem
  private let socketPath: String

  // Latest snapshots of daemon state. Rebuilt on every push event.
  private var status: StatusPayload?
  private var queueState: QueueStatePayload?
  private var queueItems: [QueueStatePayload.QueueItem] = []
  // 1 Hz timer that re-renders the menu while a recording is in
  // progress. Without it, the "Recording M:SS" header freezes at the
  // value of the first `status_changed` push (v0.9.2 fix). v0.9.6
  // removed the parallel undo-countdown timer — the stop flow moved
  // to a notification banner; there is no menu-bar undo affordance.
  private var recordingTickTimer: Timer?
  // Live reference to the recording header item. v0.9.5: we mutate
  // the title on the currently-tracking item + call
  // `NSMenu.update()` instead of calling `rebuildMenu()`, because
  // reassigning `statusItem.menu` doesn't refresh the
  // already-tracking menu (NSMenu snapshots its layout when it
  // opens). The ref is reset on every `rebuildMenu()`; the timer
  // callback no-ops when the ref is nil (state transitioned away).
  private weak var recordingHeaderItem: NSMenuItem?

  // Subscriber connection (long-lived). Per-op ops use one-shots.
  private var subscriber: DaemonConnection?
  private var reconnectBackoffIdx = 0
  private let reconnectBackoffSec: [TimeInterval] = [1, 5, 30, 60]
  private var disconnected = true

  // v0.9.11: opt-in global stop-recording hotkey. The monitor is
  // installed ONLY while recording is active and a hotkey is
  // configured, then torn down on stop / config disable / disconnect.
  // We never register a monitor on an idle menubar — global key
  // monitors are powerful and surprising; opt-in + lifecycle-scoped
  // keeps the surface minimal.
  private let stopHotkeyMonitor = HotkeyMonitor()
  /// Last configured hotkey string we saw from the daemon (canonical
  /// form, e.g. `cmd+shift+s`). `nil` = unconfigured / disabled.
  /// Comparing canonical strings keeps the install loop idempotent:
  /// every push of `config_reloaded` only re-parses when the value
  /// changed.
  private var configuredStopHotkey: HotkeyCombo?

  init(socketPath: String) {
    self.socketPath = socketPath
    self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    super.init()
  }

  func start() {
    NSApp.setActivationPolicy(.accessory)
    if let button = statusItem.button {
      // Initial render before any daemon connection — keep the icon
      // muted so the user sees "menu bar is alive but not yet
      // connected" rather than a misleading status.
      if let img = NSImage(systemSymbolName: "mic.slash", accessibilityDescription: "swrag idle") {
        img.isTemplate = true
        button.image = img
      } else {
        button.title = "swrag"
      }
    }
    rebuildMenu()
    connectSubscriber()
  }

  // MARK: - Subscriber lifecycle

  private func connectSubscriber() {
    let conn = DaemonConnection(socketPath: socketPath)
    conn.onStateChange = { [weak self] newState in
      DispatchQueue.main.async {
        guard let self = self else { return }
        switch newState {
        case .ready:
          self.disconnected = false
          self.reconnectBackoffIdx = 0
          // Send subscribe immediately after connect — the daemon
          // replies with an initial snapshot envelope.
          conn.sendRawJSON(["op": "subscribe"])
          self.rebuildMenu()
        case .failed, .closed:
          self.disconnected = true
          self.subscriber = nil
          self.scheduleReconnect()
          self.rebuildMenu()
        default:
          break
        }
      }
    }
    conn.onError = { [weak self] _ in
      DispatchQueue.main.async {
        self?.disconnected = true
        self?.subscriber?.cancel()
        self?.subscriber = nil
        self?.scheduleReconnect()
        self?.rebuildMenu()
      }
    }
    conn.onLine = { [weak self] data in
      DispatchQueue.main.async {
        self?.handleIncomingLine(data)
      }
    }
    self.subscriber = conn
    conn.connect()
  }

  private func scheduleReconnect() {
    let delay = reconnectBackoffSec[min(reconnectBackoffIdx, reconnectBackoffSec.count - 1)]
    reconnectBackoffIdx += 1
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self = self else { return }
      if self.subscriber == nil {
        self.connectSubscriber()
      }
    }
  }

  // MARK: - Inbound event handling

  private func handleIncomingLine(_ data: Data) {
    // The daemon may push any of: subscribed envelope, status_changed,
    // queue_state_changed, queue_changed, detect_changed, shutdown.
    // We parse leniently — the daemon's payload includes an `event`
    // discriminator and (for subscription) an embedded `status`
    // snapshot.
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return
    }
    if let event = json["event"] as? String {
      handlePushEvent(event: event, payload: json, raw: data)
      return
    }
    // Could be a one-shot response (shape varies); ignore on the
    // subscriber channel — one-shots use their own ephemeral
    // connections.
  }

  private func handlePushEvent(event: String, payload: [String: Any], raw: Data) {
    switch event {
    case "subscribed":
      // Initial snapshot is embedded under `status`. Parse it through
      // the dedicated Decodable so we get type-checked values.
      if let envelope = try? JSONDecoder().decode(SubscribedEnvelope.self, from: raw) {
        if let s = envelope.status {
          self.status = s
          // Carry the hotkey config off the initial snapshot — saves
          // a round-trip to the daemon. Mutations after subscribe
          // arrive via `config_reloaded` (handled below).
          self.updateConfiguredStopHotkey(s.hotkeys?.stopRecording)
        }
      }
      // Pull a fresh queue snapshot via a one-shot — the subscribed
      // envelope only carries `status`, not `queue_state`.
      fetchQueueSnapshot()
      rebuildMenu()
    case "status_changed":
      // The status payload is not embedded here; fetch fresh.
      fetchStatus()
      rebuildMenu()
    case "queue_state_changed":
      // The payload carries the full queue_state snapshot.
      if let qs = try? JSONDecoder().decode(QueueStatePayload.self, from: raw) {
        self.queueState = qs
        rebuildMenu()
      }
      // Also pull the full list so per-item rendering stays in sync.
      fetchQueueList()
    case "queue_changed":
      fetchQueueList()
      fetchStatus()
    case "detect_changed":
      // Detector visibility is debug-only in this UI; don't surface.
      _ = payload
    case "config_reloaded":
      // v0.9.11: daemon re-broadcasts the full popup config on every
      // CLI mutation via `swrag meeting config …`. We only care about
      // the hotkeys block — the rest of the config doesn't reach the
      // menubar surface.
      if let envelope = try? JSONDecoder().decode(ConfigReloadedEnvelope.self, from: raw) {
        self.updateConfiguredStopHotkey(envelope.config?.hotkeys?.stopRecording)
        self.reconcileStopHotkeyMonitor()
      }
    case "shutdown":
      // Daemon is going away. Drop the subscriber + show "Daemon
      // unavailable" until the next launchd respawn brings it back.
      self.subscriber?.cancel()
      self.subscriber = nil
      self.disconnected = true
      // No daemon = nowhere to send `record_stop`; the hotkey would
      // do nothing. Pull the monitor proactively so we don't leak
      // a key-grabbing closure across the disconnect.
      self.stopHotkeyMonitor.remove()
      self.scheduleReconnect()
      rebuildMenu()
    default:
      break
    }
  }

  // MARK: - One-shot ops (ephemeral connection per op)

  /// Run an op against a fresh connection; ignore the response. Used
  /// for fire-and-forget menu clicks (the next pushed event from the
  /// subscriber refreshes the menu state).
  private func dispatchOp(_ json: [String: Any]) {
    let conn = DaemonConnection(socketPath: socketPath)
    conn.onStateChange = { newState in
      if case .ready = newState {
        conn.sendRawJSON(json)
        // Close after a tiny delay so the server sees the data.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
          conn.cancel()
        }
      }
    }
    conn.connect()
  }

  /// Run an op and decode the response. Used by `fetchStatus`,
  /// `fetchQueueList`, `fetchQueueSnapshot`.
  private func dispatchOpExpectingResponse(
    _ json: [String: Any],
    onResponse: @escaping (Data) -> Void
  ) {
    let conn = DaemonConnection(socketPath: socketPath)
    var responded = false
    conn.onStateChange = { newState in
      if case .ready = newState {
        conn.sendRawJSON(json)
      }
    }
    conn.onLine = { data in
      if responded { return }
      responded = true
      DispatchQueue.main.async {
        onResponse(data)
        conn.cancel()
      }
    }
    conn.onError = { _ in
      if !responded {
        responded = true
        conn.cancel()
      }
    }
    conn.connect()
  }

  private func fetchStatus() {
    dispatchOpExpectingResponse(["op": "status"]) { [weak self] data in
      guard let self = self else { return }
      if let s = try? JSONDecoder().decode(StatusPayload.self, from: data) {
        self.status = s
        // Status responses also carry hotkey config (since v0.9.11);
        // keep our local view in sync so a transient disconnect
        // doesn't lose the configured hotkey.
        self.updateConfiguredStopHotkey(s.hotkeys?.stopRecording)
        self.rebuildMenu()
      }
    }
  }

  private func fetchQueueSnapshot() {
    dispatchOpExpectingResponse(["op": "queue_state"]) { [weak self] data in
      guard let self = self else { return }
      if let qs = try? JSONDecoder().decode(QueueStatePayload.self, from: data) {
        self.queueState = qs
        self.rebuildMenu()
      }
    }
    fetchQueueList()
  }

  private func fetchQueueList() {
    dispatchOpExpectingResponse(["op": "queue_list"]) { [weak self] data in
      guard let self = self else { return }
      if let payload = try? JSONDecoder().decode(QueueListPayload.self, from: data) {
        self.queueItems = payload.items
        self.rebuildMenu()
      }
    }
  }

  // MARK: - ISO8601 parsing

  private func isoDate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
  }

  // MARK: - Recording elapsed-time timer (v0.9.2)

  /// Reconcile `recordingTickTimer` against the current
  /// `(disconnected, status.recording)` state. Called from
  /// `rebuildMenu()` after every state mutation:
  ///
  ///   - Idle → recording: spin up a 1 Hz timer that drives
  ///     `tickRecordingElapsed()` so the "Recording M:SS" header
  ///     tracks real time instead of freezing on the first push event
  ///     (v0.9.2 base fix; v0.9.5 changed it from `rebuildMenu()` to
  ///     an in-place title update so the visible counter ticks even
  ///     while the menu is open — see `tickRecordingElapsed`).
  ///   - Recording → idle (or disconnected, or shutdown): tear down
  ///     the timer so we don't keep waking the run loop or holding a
  ///     strong reference to self via the timer block, and call
  ///     `rebuildMenu()` once to swap the menu shape.
  ///   - Recording → still recording: no-op (we don't churn the
  ///     timer; otherwise every tick would also re-create the
  ///     timer the tick is currently driving).
  ///
  /// `Timer.invalidate()` is required to release the timer's retain
  /// on its block; ARC alone doesn't break the cycle.
  private func updateRecordingTickTimer() {
    let needsTimer = !disconnected && (status?.recording ?? false)
    if needsTimer {
      if recordingTickTimer != nil { return }
      // Manual Timer + dual-mode registration (v0.9.4): `.common` keeps the
      // tick alive in `.default`/modal-panel modes; `.eventTracking` keeps it
      // alive while the user has the NSMenu open (NSMenu tracking is NOT a
      // member of `.common`, so a scheduledTimer freezes the visible
      // "Recording M:SS" header until the menu is dismissed).
      let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
        guard let self = self else { return }
        if self.disconnected || !(self.status?.recording ?? false) {
          self.recordingTickTimer?.invalidate()
          self.recordingTickTimer = nil
          // State transitioned out of recording — full rebuild swaps
          // the menu to the non-recording shape.
          self.rebuildMenu()
          return
        }
        self.tickRecordingElapsed()
      }
      RunLoop.main.add(t, forMode: .common)
      RunLoop.main.add(t, forMode: .eventTracking)
      recordingTickTimer = t
    } else if recordingTickTimer != nil {
      recordingTickTimer?.invalidate()
      recordingTickTimer = nil
    }
  }

  /// v0.9.5: in-place title update on the currently-tracking menu item
  /// instead of `rebuildMenu()`.
  ///
  /// `rebuildMenu()` constructs a brand-new `NSMenu` and assigns it to
  /// `statusItem.menu`, but that doesn't refresh the menu the user is
  /// currently looking at — NSMenu snapshots its layout when it opens
  /// and the reassignment only takes effect on the *next* open. The
  /// dual-mode timer registration from v0.9.4 made the tick fire, but
  /// the visible header still froze because we were mutating an
  /// off-screen menu.
  ///
  /// The fix: keep a weak ref to the recording header item created in
  /// the last `rebuildMenu()`, mutate its `title` directly, then call
  /// `menu.update()` to force NSMenu to re-validate its items and
  /// redraw the changed title in the currently-tracking layout.
  ///
  /// `NSMenuItem.menu` is the (weak) backref to the enclosing NSMenu;
  /// if `rebuildMenu()` has run since the item was created, the item
  /// is detached and `menu` is nil → no-op until the next rebuild
  /// re-establishes a ref.
  private func tickRecordingElapsed() {
    guard let status = status, status.recording else { return }
    guard let item = recordingHeaderItem else { return }
    let since = status.since.flatMap(isoDate)
    let elapsed = since.map { Date().timeIntervalSince($0) } ?? 0
    item.title = String(format: "Recording %@", formatElapsed(elapsed))
    item.menu?.update()
  }

  // MARK: - Menu construction

  private func rebuildMenu() {
    let menu = NSMenu()

    if disconnected {
      let item = NSMenuItem(title: "Daemon unavailable", action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
      menu.addItem(.separator())
      menu.addItem(makeItem(title: "Quit menu bar", action: #selector(quit)))
      statusItem.menu = menu
      updateIcon(state: .daemonUnavailable)
      return
    }

    // Recording header (orthogonal overlay per the spec — visible
    // independently of the queue state). v0.9.5: stash the header ref
    // so the tick timer can mutate its title in-place + force a
    // redraw via `NSMenu.update()`.
    if let status = status, status.recording {
      let since = status.since.flatMap(isoDate)
      let elapsed = since.map { Date().timeIntervalSince($0) } ?? 0
      let header = NSMenuItem(
        title: String(format: "Recording %@", formatElapsed(elapsed)),
        action: nil,
        keyEquivalent: ""
      )
      header.isEnabled = false
      menu.addItem(header)
      recordingHeaderItem = header
      menu.addItem(makeItem(title: "Stop & save", action: #selector(stopAndSave)))
      menu.addItem(makeItem(title: "Stop & discard", action: #selector(stopAndDiscard)))
      menu.addItem(.separator())
    } else {
      recordingHeaderItem = nil
      menu.addItem(makeItem(title: "Start recording…", action: #selector(startRecording)))
      menu.addItem(.separator())
    }

    // Queue state.
    let queueStateStr = queueState?.state ?? "?"
    let pending = status?.queuePending ?? 0
    let batchSize = queueState?.batchSize ?? 0
    let batchPos = queueState?.batchPosition ?? 0
    let headerTitle: String
    switch queueStateStr {
    case "paused":
      headerTitle = pending == 0 ? "Paused — no pending recordings" : "Paused — \(pending) pending"
    case "processing":
      headerTitle = "Processing \(batchPos + 1) of \(batchSize)"
    case "pausing":
      headerTitle = "Pausing — finishing current item…"
    default:
      headerTitle = "Queue: \(queueStateStr)"
    }
    let queueHeader = NSMenuItem(title: headerTitle, action: nil, keyEquivalent: "")
    queueHeader.isEnabled = false
    menu.addItem(queueHeader)

    // Toggle: start / pause depending on state.
    switch queueStateStr {
    case "paused":
      if pending > 0 {
        menu.addItem(
          makeItem(title: "▶ Start queue processing", action: #selector(queueStart)))
      }
    case "processing":
      menu.addItem(
        makeItem(title: "⏸ Pause after current", action: #selector(queuePause)))
    case "pausing":
      let disabled = NSMenuItem(title: "(pausing…)", action: nil, keyEquivalent: "")
      disabled.isEnabled = false
      menu.addItem(disabled)
    default:
      break
    }

    // Per-item submenu.
    if !queueItems.isEmpty {
      let submenuRoot = NSMenuItem(title: "Recordings", action: nil, keyEquivalent: "")
      let submenu = NSMenu()
      let currentId = queueState?.currentItem?.id
      for item in queueItems {
        let marker: String
        switch item.status {
        case "transcribing": marker = "●"
        case "completed": marker = "✓"
        case "failed": marker = "✗"
        default: marker = " "
        }
        let dur = item.durationMs.map { String(format: "%.1f min", Double($0) / 60_000.0) } ?? "?"
        let labelStr = item.label.map { " [\($0)]" } ?? ""
        let title = "\(marker) \(item.capturedAt)  ·  \(dur)\(labelStr)"
        let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        if item.status == "pending" && item.id != currentId {
          let discard = makeItem(title: "Discard", action: #selector(discardItem(_:)))
          discard.representedObject = item.id
          sub.addItem(discard)
        }
        let show = makeItem(title: "Show in Finder", action: #selector(showInFinder(_:)))
        // We don't know the wav path from the queue_list response
        // shape (it intentionally excludes paths); we send the row id
        // and look up the path during the action handler. The action
        // handler resolves via a separate `status` call when needed.
        show.representedObject = item.id
        sub.addItem(show)
        entry.submenu = sub
        submenu.addItem(entry)
      }
      submenuRoot.submenu = submenu
      menu.addItem(submenuRoot)
    }

    menu.addItem(.separator())
    menu.addItem(makeItem(title: "Open queue folder", action: #selector(openQueueFolder)))
    menu.addItem(.separator())
    menu.addItem(makeItem(title: "Quit menu bar", action: #selector(quit)))

    statusItem.menu = menu
    updateIcon(state: iconStateFor())
    // Drive the recording elapsed-time tick off the same state we
    // just rendered. Idempotent — only re-creates the timer on
    // recording-state transitions.
    updateRecordingTickTimer()
    // v0.9.11: arm/disarm the stop-recording hotkey on every menu
    // rebuild. Reconcile is idempotent — only mutates the underlying
    // NSEvent monitor on a real state transition (recording on/off
    // or configured hotkey changed).
    reconcileStopHotkeyMonitor()
  }

  // MARK: - Stop-recording hotkey (v0.9.11)

  /// Parse the latest hotkey string from the daemon and stash the
  /// parsed combo on the controller. Called from every payload that
  /// could carry hotkey config (subscribe envelope, fetched status,
  /// `config_reloaded` push).
  ///
  /// `raw == nil` means "unconfigured" — we drop any prior combo so
  /// the reconciler removes the monitor on the next pass.
  private func updateConfiguredStopHotkey(_ raw: String?) {
    guard let raw = raw, !raw.isEmpty else {
      configuredStopHotkey = nil
      return
    }
    guard let combo = HotkeyCombo.parse(raw) else {
      // Unparseable hotkey strings get logged + dropped. The TS-side
      // schema only validates that the value is a non-empty string;
      // we do the structural validation here so a typo doesn't blow
      // up the menubar.
      FileHandle.standardError.write(
        Data("menubar: unparseable hotkey \(raw); ignoring\n".utf8)
      )
      configuredStopHotkey = nil
      return
    }
    configuredStopHotkey = combo
  }

  /// Install or remove the global stop-recording monitor based on
  /// current state. The monitor is active ONLY when:
  ///   * the daemon is connected,
  ///   * a recording is in progress,
  ///   * a parseable hotkey is configured.
  ///
  /// Anything else → monitor removed (no stray key-grabbing closure
  /// while the menubar is idle).
  private func reconcileStopHotkeyMonitor() {
    let isRecording = !disconnected && (status?.recording ?? false)
    guard isRecording, let combo = configuredStopHotkey else {
      stopHotkeyMonitor.remove()
      return
    }
    // Idempotent: if the same combo is already installed, leave it.
    // Otherwise replace (the monitor itself removes the prior one).
    if stopHotkeyMonitor.current == combo { return }
    stopHotkeyMonitor.install(combo: combo) { [weak self] in
      DispatchQueue.main.async {
        self?.dispatchOp(["op": "record_stop", "discard": false])
      }
    }
  }

  // MARK: - Icon

  private enum IconState {
    case idleEmpty
    case idleWithQueue(count: Int)
    case processing
    case recording
    case daemonUnavailable
  }

  private func iconStateFor() -> IconState {
    if disconnected { return .daemonUnavailable }
    if let s = status, s.recording { return .recording }
    let qs = queueState?.state ?? "paused"
    let pending = status?.queuePending ?? 0
    if qs == "processing" { return .processing }
    if pending > 0 { return .idleWithQueue(count: pending) }
    return .idleEmpty
  }

  private func updateIcon(state: IconState) {
    guard let button = statusItem.button else { return }
    let symbolName: String
    var title: String = ""
    switch state {
    case .idleEmpty:
      symbolName = "mic"
    case .idleWithQueue(let count):
      symbolName = "mic.fill"
      if count > 3 { title = " \(count)" }
    case .processing:
      symbolName = "waveform"
    case .recording:
      symbolName = "record.circle.fill"
    case .daemonUnavailable:
      symbolName = "mic.slash"
    }
    if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: "swrag status") {
      img.isTemplate = true
      button.image = img
      button.title = title
    } else {
      button.image = nil
      button.title = "swrag" + title
    }
  }

  // MARK: - Menu actions

  @objc private func startRecording() {
    dispatchOp(["op": "record_start"])
  }

  @objc private func stopAndSave() {
    dispatchOp(["op": "record_stop", "discard": false])
  }

  @objc private func stopAndDiscard() {
    dispatchOp(["op": "record_stop", "discard": true])
  }

  @objc private func queueStart() {
    dispatchOp(["op": "queue_start"])
  }

  @objc private func queuePause() {
    dispatchOp(["op": "queue_pause"])
  }

  @objc private func discardItem(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? Int else { return }
    dispatchOp(["op": "queue_discard", "id": id])
  }

  @objc private func showInFinder(_ sender: NSMenuItem) {
    // The queue_list response intentionally doesn't include audio
    // paths (the menu bar shouldn't need them for routine display).
    // For "Show in Finder" we fall back to opening the meetings
    // incoming dir — better than nothing, and the user usually wants
    // to inspect the folder anyway.
    _ = sender
    openQueueFolder()
  }

  @objc private func openQueueFolder() {
    let path = NSHomeDirectory()
      + "/Library/Application Support/superwhisper-rag/meetings/incoming"
    let url = URL(fileURLWithPath: path)
    NSWorkspace.shared.activateFileViewerSelecting([url])
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  // MARK: - Helpers

  private func makeItem(title: String, action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    return item
  }

  private func formatElapsed(_ seconds: TimeInterval) -> String {
    let s = max(0, Int(seconds))
    if s >= 3600 {
      return String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
    }
    return String(format: "%02d:%02d", s / 60, s % 60)
  }
}

func runMenuBar(args: [String]) {
  // Allow `--socket <path>` to override for tests / dev. Default is
  // the user's standard daemon socket.
  var socketPath = DEFAULT_SOCKET_PATH
  var i = 0
  while i < args.count {
    if args[i] == "--socket" && i + 1 < args.count {
      socketPath = args[i + 1]
      i += 2
    } else {
      i += 1
    }
  }
  let app = NSApplication.shared
  let controller = MenuBarController(socketPath: socketPath)
  // Strong reference so ARC doesn't release the controller while the
  // app loop is running. We deliberately leak it for the lifetime of
  // the process — same trick the recorder uses for its singleton.
  let retainedController = Unmanaged.passRetained(controller)
  _ = retainedController
  controller.start()
  app.run()
}
