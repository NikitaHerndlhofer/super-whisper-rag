import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// `swrag-helper record --output <path> [--system-audio]`
//
// Long-running. Captures the microphone via AVAudioEngine with
// VoiceProcessingIO enabled (Apple's stock AEC/AGC/NR — kills the
// system-audio-through-speakers double-count for free) and optionally
// the system audio mix via ScreenCaptureKit. Both streams are
// resampled to 16 kHz mono Float32, summed sample-by-sample with soft
// clipping, and written to a WAV file (16-bit PCM 16 kHz mono) via
// AVAudioFile. Heartbeats land on stdout every ~1 s as line-delimited
// JSON. Clean shutdown on SIGTERM/SIGINT: stop engine, stop SCStream,
// flush + close the file, verify a non-zero readable WAV, exit 0.
//
// Why VPIO and not AVCaptureSession: VPIO activates
// `kAudioUnitSubType_VoiceProcessingIO` which gives us hardware-grade
// echo cancellation against the speaker output. When the user is on
// speakers in a call, the mic picks up the remote party's voice
// played back through speakers; without AEC that audio ends up in
// BOTH our mic track and our system-audio track and double-counts in
// the resulting transcript. VPIO's ~10–30 ms latency is irrelevant
// for offline transcribe-later.

private let TARGET_SAMPLE_RATE: Double = 16_000
private let HEARTBEAT_INTERVAL_NS: UInt64 = 1_000_000_000  // 1 s

/// Recorder lifecycle. Holds the engine, optional SCStream, the
/// AVAudioFile, both converters, and the mixing/peak-tracking state.
/// One instance per `record` invocation.
private final class Recorder {
  private let outputURL: URL
  private let captureSystemAudio: Bool

  private let engine = AVAudioEngine()
  private var audioFile: AVAudioFile?
  /// Target processing format we write to the WAV file: 16 kHz mono
  /// Float32 (interleaved=false; mono is unambiguous either way).
  /// AVAudioFile transparently down-converts to Int16 on write because
  /// the file settings declare 16-bit PCM.
  private let targetFormat: AVAudioFormat

  /// Resamples mic input (VPIO native format, typically 24 kHz mono
  /// Float32) to `targetFormat`. Created on demand once we observe
  /// the input node's actual output format — VPIO may pick different
  /// rates on different hardware.
  private var micConverter: AVAudioConverter?

  /// Resamples SCK audio (its actual delivered format — usually 48 kHz
  /// stereo Float32 LPCM) to `targetFormat`. Created lazily on the
  /// first SCK sample buffer because we don't know the source format
  /// until SCK starts producing samples.
  private var sysConverter: AVAudioConverter?

  /// Lock guarding `audioFile`, the system-audio backlog, and the
  /// stats below. SCK delivers on its own sampleHandlerQueue while
  /// the mic tap delivers on the engine's render thread; we need a
  /// serial point to write into the file.
  private let lock = NSLock()

  /// Pending system-audio frames at 16 kHz mono Float32. We mix at
  /// the cadence of the mic tap: when the mic tap fires with N
  /// frames, we pop up to N system-audio frames from the head and
  /// sum them in. If SCK is lagging we write mic-only for that
  /// segment; the next mic tap mixes in whatever SCK has accumulated.
  private var systemAudioBacklog: [Float] = []
  /// Hard cap so SCK can't unbounded-grow if mic stalls. Drops
  /// oldest samples on overflow (1 s = 16k samples per channel).
  private let systemAudioBacklogCap = 16_000 * 4  // 4 s of slack

  /// Total mono frames written to the WAV file (post-mix).
  private var framesWritten: UInt64 = 0
  /// Peak absolute amplitude in [0, 1] observed since the previous
  /// heartbeat — reset on every emit.
  private var peakSinceLastBeat: Float = 0

  private var heartbeatTimer: DispatchSourceTimer?
  private var signalSources: [DispatchSourceSignal] = []

  /// The SCStream owns the system-audio output handler; we hold a
  /// reference here so it lives as long as the recorder does.
  private var scStream: SCStream?
  private var scOutputHandler: SystemAudioOutput?

  /// Set to true once we've started shutting down — guards against
  /// re-entry from a second SIGTERM or from the engine main thread
  /// trying to call into a half-torn-down state.
  private var stopping = false
  /// True once shutdown finishes cleanly (used by the entry point to
  /// decide whether `exit(0)` is appropriate).
  private var stoppedSuccessfully = false

  init(outputURL: URL, captureSystemAudio: Bool) throws {
    self.outputURL = outputURL
    self.captureSystemAudio = captureSystemAudio
    guard let target = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      interleaved: false
    ) else {
      throw RecorderError("failed to construct 16 kHz mono Float32 target format")
    }
    self.targetFormat = target
  }

  /// Synchronous setup. Returns once mic + (optional) SCK + signal
  /// handlers are wired and the engine is producing audio. The
  /// caller (the `runRecord` entry point) is on the main thread and
  /// runs `RunLoop.main.run()` *itself* after we return — this is
  /// critical because the signal handlers are dispatched on `.main`,
  /// and the main runloop has to be pumped by the main thread for
  /// those handlers to fire on SIGTERM/SIGINT. An earlier draft
  /// called `RunLoop.main.run()` from inside an async Task; the Task
  /// ran on a background executor thread and the main runloop never
  /// got pumped, so signals were dropped and graceful shutdown
  /// silently hung. See https://forums.swift.org/t/runloop-main-run/
  /// for the underlying rule.
  func startBlocking() throws {
    try openOutputFile()
    try configureMicrophone()
    if captureSystemAudio {
      try configureSystemAudioSync()
    }
    installSignalHandlers()
    startHeartbeatTimer()
    try engine.start()
    if let stream = scStream {
      try startSCStreamSync(stream)
    }
  }

  // MARK: - WAV output

  private func openOutputFile() throws {
    let dir = outputURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: TARGET_SAMPLE_RATE,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    // commonFormat: .pcmFormatFloat32 means we write Float32 buffers
    // and AVAudioFile down-converts to Int16 per the file settings.
    audioFile = try AVAudioFile(
      forWriting: outputURL,
      settings: settings,
      commonFormat: .pcmFormatFloat32,
      interleaved: false
    )
  }

  // MARK: - Microphone (AVAudioEngine + VPIO)

  private func configureMicrophone() throws {
    let input = engine.inputNode
    // VPIO MUST be enabled before the engine starts. After this call
    // the input node's output format reflects VPIO's preferred rate
    // (typically 24 kHz mono Float32 on macOS) regardless of what the
    // hardware reports.
    do {
      try input.setVoiceProcessingEnabled(true)
    } catch {
      throw RecorderError(
        "failed to enable VoiceProcessingIO on the input node: \(error.localizedDescription). " +
        "Verify Microphone permission is granted to this process."
      )
    }
    let inputFormat = input.outputFormat(forBus: 0)
    if inputFormat.sampleRate <= 0 || inputFormat.channelCount == 0 {
      throw RecorderError(
        "input node reports invalid format after enabling VPIO " +
        "(sr=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount)). " +
        "Mic permission may be denied."
      )
    }
    // Convert mic → 16 kHz mono Float32.
    micConverter = AVAudioConverter(from: inputFormat, to: targetFormat)
    if micConverter == nil {
      throw RecorderError(
        "failed to construct mic AVAudioConverter from " +
        "\(inputFormat) to \(targetFormat)"
      )
    }
    // Tap installed at the input node's NATIVE format so VPIO sees no
    // intermediate conversion. We convert in the tap callback.
    input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
      self?.handleMicBuffer(buffer)
    }
  }

  private func handleMicBuffer(_ buffer: AVAudioPCMBuffer) {
    guard let converter = micConverter else { return }
    // Output buffer capacity: input frames × (target rate / input rate),
    // padded for safety. Converter may consume more or fewer frames per
    // call due to its internal resampler state; the docs recommend
    // sizing to the largest plausible output count.
    let ratio = targetFormat.sampleRate / buffer.format.sampleRate
    let outFrames = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 16)
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outFrames) else {
      return
    }
    var consumed = false
    var convError: NSError?
    let status = converter.convert(to: outBuffer, error: &convError) { _, outStatus in
      if consumed {
        outStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      outStatus.pointee = .haveData
      return buffer
    }
    if status == .error || convError != nil {
      // Skip this buffer rather than tear down the whole recorder
      // over a single conversion blip. Failures usually mean a format
      // mismatch that won't fix itself; the next call will surface
      // the same error and the user will see the WAV stop growing.
      return
    }
    writeMixed(outBuffer)
  }

  // MARK: - System audio (ScreenCaptureKit)

  private func configureSystemAudioSync() throws {
    // Build a filter that captures audio from the main display with
    // no app/window exclusions. SCK requires a display in the filter
    // even for audio-only captures; the chosen display is irrelevant
    // because we don't enable video.
    //
    // SCShareableContent.current is async-only on macOS 13+. We block
    // the main thread on a semaphore so the rest of the setup path
    // stays synchronous — the entry point pumps the main runloop
    // *after* setup completes, so blocking briefly here is fine.
    let contentResult: Result<SCShareableContent, Error> = blockingAwaitContent()
    let content: SCShareableContent
    switch contentResult {
    case .success(let c): content = c
    case .failure(let error):
      throw RecorderError(
        "ScreenCaptureKit setup failed (screen recording permission may be denied): " +
        "\(error.localizedDescription)"
      )
    }
    guard let display = content.displays.first else {
      throw RecorderError(
        "ScreenCaptureKit reports no displays — screen recording permission " +
        "may be denied; check System Settings → Privacy & Security → Screen Recording."
      )
    }
    let filter = SCContentFilter(
      display: display,
      excludingApplications: [],
      exceptingWindows: []
    )
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 48_000
    config.channelCount = 2
    // Minimize video work — we don't tap the video output but SCK
    // still allocates resources for it. The smallest reasonable size
    // keeps overhead negligible.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    let handler = SystemAudioOutput { [weak self] sampleBuffer in
      self?.handleSystemAudioSample(sampleBuffer)
    }
    let stream = SCStream(filter: filter, configuration: config, delegate: handler)
    do {
      try stream.addStreamOutput(
        handler,
        type: .audio,
        sampleHandlerQueue: DispatchQueue(label: "swrag-helper.record.sys-audio")
      )
    } catch {
      throw RecorderError(
        "ScreenCaptureKit addStreamOutput failed (screen recording): " +
        "\(error.localizedDescription)"
      )
    }
    self.scStream = stream
    self.scOutputHandler = handler
  }

  /// Block the main thread on `SCShareableContent.current`. The whole
  /// recorder setup is supposed to run synchronously on the main
  /// thread (so the main runloop is available to dispatch signal
  /// handlers afterward), but SCK only exposes content discovery via
  /// async. We bridge with a semaphore. The main runloop is NOT yet
  /// pumping during setup, so blocking here doesn't starve any
  /// dispatch sources.
  private func blockingAwaitContent() -> Result<SCShareableContent, Error> {
    let sem = DispatchSemaphore(value: 0)
    var result: Result<SCShareableContent, Error>?
    Task.detached {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(
          false, onScreenWindowsOnly: false
        )
        result = .success(content)
      } catch {
        result = .failure(error)
      }
      sem.signal()
    }
    sem.wait()
    // result is set by the Task before signal() runs.
    return result ?? .failure(RecorderError("SCShareableContent: no result captured"))
  }

  /// Block the main thread on `SCStream.startCapture()`. Same pattern
  /// as `blockingAwaitContent` — we want the entry point to stay
  /// synchronous so the main runloop is free to handle signals once
  /// setup is complete.
  private func startSCStreamSync(_ stream: SCStream) throws {
    let sem = DispatchSemaphore(value: 0)
    var startError: Error?
    Task.detached {
      do {
        try await stream.startCapture()
      } catch {
        startError = error
      }
      sem.signal()
    }
    sem.wait()
    if let err = startError {
      throw RecorderError(
        "ScreenCaptureKit startCapture failed (screen recording permission may be denied): " +
        "\(err.localizedDescription)"
      )
    }
  }

  private func handleSystemAudioSample(_ sampleBuffer: CMSampleBuffer) {
    guard CMSampleBufferIsValid(sampleBuffer) else { return }
    guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else {
      return
    }
    var asbd = asbdPtr.pointee
    guard let sourceFormat = AVAudioFormat(streamDescription: &asbd) else {
      return
    }
    // Build / refresh the system-audio converter on the first sample
    // and whenever the source format changes underneath us (rare but
    // possible if SCK negotiates a different format mid-stream).
    if sysConverter == nil || sysConverter?.inputFormat != sourceFormat {
      sysConverter = AVAudioConverter(from: sourceFormat, to: targetFormat)
    }
    guard let converter = sysConverter else { return }

    let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
    guard let inBuffer = pcmBuffer(from: sampleBuffer, format: sourceFormat, frameCount: numSamples)
    else { return }

    let ratio = targetFormat.sampleRate / sourceFormat.sampleRate
    let outFrames = AVAudioFrameCount(Double(inBuffer.frameLength) * ratio + 16)
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outFrames) else {
      return
    }
    var consumed = false
    var convError: NSError?
    let status = converter.convert(to: outBuffer, error: &convError) { _, outStatus in
      if consumed {
        outStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      outStatus.pointee = .haveData
      return inBuffer
    }
    if status == .error || convError != nil {
      return
    }
    appendToSystemBacklog(outBuffer)
  }

  /// Copy the audio PCM samples out of a CMSampleBuffer into an
  /// AVAudioPCMBuffer of `format`. Assumes `format` is interleaved
  /// Float32 (SCK's default LPCM delivery is Float32; verify before
  /// dereferencing if support for other depths is added).
  private func pcmBuffer(
    from sampleBuffer: CMSampleBuffer,
    format: AVAudioFormat,
    frameCount: CMItemCount
  ) -> AVAudioPCMBuffer? {
    let asbd = format.streamDescription.pointee
    // Only support common LPCM Float32 paths — SCK delivers this by
    // default; anything else is unexpected and we skip the buffer.
    let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    let bytesPerSample = Int(asbd.mBitsPerChannel / 8)
    guard isFloat, bytesPerSample == 4 else { return nil }

    guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount))
    else { return nil }
    pcm.frameLength = AVAudioFrameCount(frameCount)

    guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
    let totalBytes = Int(frameCount) * Int(asbd.mBytesPerFrame)
    var lengthAtOffset: Int = 0
    var totalLength: Int = 0
    var dataPointer: UnsafeMutablePointer<Int8>?
    let status = CMBlockBufferGetDataPointer(
      blockBuffer,
      atOffset: 0,
      lengthAtOffsetOut: &lengthAtOffset,
      totalLengthOut: &totalLength,
      dataPointerOut: &dataPointer
    )
    guard status == kCMBlockBufferNoErr, let src = dataPointer, totalLength >= totalBytes else {
      return nil
    }

    if format.isInterleaved {
      // Single channel-data buffer; copy as-is.
      guard let dst = pcm.floatChannelData?[0] else { return nil }
      src.withMemoryRebound(to: Float.self, capacity: Int(frameCount) * Int(asbd.mChannelsPerFrame)) { fsrc in
        dst.update(from: fsrc, count: Int(frameCount) * Int(asbd.mChannelsPerFrame))
      }
    } else {
      // Non-interleaved: each channel has its own data block laid out
      // sequentially in the CMBlockBuffer.
      let channels = Int(asbd.mChannelsPerFrame)
      let bytesPerChannel = Int(frameCount) * bytesPerSample
      for ch in 0..<channels {
        guard let dst = pcm.floatChannelData?[ch] else { return nil }
        let offset = ch * bytesPerChannel
        let srcCh = src.advanced(by: offset)
        srcCh.withMemoryRebound(to: Float.self, capacity: Int(frameCount)) { fsrc in
          dst.update(from: fsrc, count: Int(frameCount))
        }
      }
    }
    return pcm
  }

  /// Append a 16 kHz mono PCM buffer to the SCK backlog. The buffer
  /// may have multiple channels (SCK's stereo output downmixed by
  /// the converter to mono works most of the time, but in case the
  /// converter preserved channels we average).
  private func appendToSystemBacklog(_ buffer: AVAudioPCMBuffer) {
    guard let channels = buffer.floatChannelData else { return }
    let frames = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    if frames == 0 { return }

    lock.lock()
    defer { lock.unlock() }
    let oldCount = systemAudioBacklog.count
    systemAudioBacklog.reserveCapacity(oldCount + frames)
    if channelCount == 1 {
      let ch0 = channels[0]
      for i in 0..<frames {
        systemAudioBacklog.append(ch0[i])
      }
    } else {
      // Downmix any residual multichannel by simple average.
      for i in 0..<frames {
        var sum: Float = 0
        for c in 0..<channelCount {
          sum += channels[c][i]
        }
        systemAudioBacklog.append(sum / Float(channelCount))
      }
    }
    // Cap the backlog: drop oldest samples if we've gone way over.
    if systemAudioBacklog.count > systemAudioBacklogCap {
      let drop = systemAudioBacklog.count - systemAudioBacklogCap
      systemAudioBacklog.removeFirst(drop)
    }
  }

  // MARK: - Mixing & file write

  /// Mic-rate driver. The mic tap delivers a steady cadence at 16 kHz
  /// after conversion; we consume the equal-length head of the system
  /// audio backlog, sum sample-by-sample with soft clipping, and write
  /// to the WAV.
  private func writeMixed(_ micBuffer: AVAudioPCMBuffer) {
    guard let micCh = micBuffer.floatChannelData?[0] else { return }
    let frames = Int(micBuffer.frameLength)
    if frames == 0 { return }

    lock.lock()
    defer { lock.unlock() }
    guard let file = audioFile, !stopping else { return }

    // Pop up to `frames` samples from the system backlog.
    let sysAvailable = min(systemAudioBacklog.count, frames)
    var sysHead: [Float] = []
    if sysAvailable > 0 {
      sysHead = Array(systemAudioBacklog.prefix(sysAvailable))
      systemAudioBacklog.removeFirst(sysAvailable)
    }

    // Build the mixed buffer.
    guard let mixed = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(frames)),
          let dst = mixed.floatChannelData?[0]
    else { return }
    mixed.frameLength = AVAudioFrameCount(frames)

    var localPeak: Float = 0
    for i in 0..<frames {
      let m = micCh[i]
      let s = (i < sysAvailable) ? sysHead[i] : 0
      // Soft clamp; the WAV writer would clip Int16-bound on its own
      // but we want explicit bounded behaviour so the level meter
      // stays in [0, 1].
      var v = m + s
      if v > 1 { v = 1 }
      else if v < -1 { v = -1 }
      dst[i] = v
      let a = v < 0 ? -v : v
      if a > localPeak { localPeak = a }
    }

    do {
      try file.write(from: mixed)
    } catch {
      // Write errors are fatal: out of space / file handle closed.
      // Drop to stderr so the TS wrapper sees something diagnostic
      // when the heartbeat stream stalls, then stop.
      let msg = "AVAudioFile write failed: \(error.localizedDescription)\n"
      FileHandle.standardError.write(Data(msg.utf8))
      stopping = true
      return
    }
    framesWritten += UInt64(frames)
    if localPeak > peakSinceLastBeat { peakSinceLastBeat = localPeak }
  }

  // MARK: - Heartbeats

  private func startHeartbeatTimer() {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "swrag-helper.record.heartbeat"))
    timer.schedule(deadline: .now() + .nanoseconds(Int(HEARTBEAT_INTERVAL_NS)), repeating: .nanoseconds(Int(HEARTBEAT_INTERVAL_NS)))
    timer.setEventHandler { [weak self] in
      self?.emitHeartbeat()
    }
    heartbeatTimer = timer
    timer.resume()
  }

  private func emitHeartbeat() {
    lock.lock()
    let frames = framesWritten
    let peak = peakSinceLastBeat
    peakSinceLastBeat = 0
    lock.unlock()
    let durationMs = Int(Double(frames) / TARGET_SAMPLE_RATE * 1000.0)
    // dBFS: 20 * log10(peak). At peak=0 we cap at -160 dB to keep
    // JSON parseable (no -Infinity).
    let dbfs: Double
    if peak <= 0 {
      dbfs = -160
    } else {
      dbfs = 20 * log10(Double(peak))
    }
    let payload = HeartbeatPayload(
      frames: Int(frames),
      durationMs: durationMs,
      levelDbfs: dbfs
    )
    // Throwing-write path so EPIPE doesn't crash us. If the write
    // fails, the parent's pipe is closed (parent died) — dispatch
    // shutdown to the main queue so the engine teardown and WAV
    // finalisation happen on the same queue the signal handlers use.
    // See the SIGPIPE block in `installSignalHandlers()` for the full
    // rationale.
    if !tryPrintJSON(payload) {
      DispatchQueue.main.async { [weak self] in
        self?.shutdown()
      }
    }
  }

  /// Variant of the file-level `printJSON` that uses the throwing
  /// `FileHandle.write(contentsOf:)` API and returns `false` on
  /// failure instead of crashing with an NSException. Specifically
  /// distinguishes "stdout pipe closed because parent died" (EPIPE)
  /// from "ran fine" without bubbling the error type into callers —
  /// the only response we ever want is "stop emitting and shut down".
  private func tryPrintJSON<T: Encodable>(_ value: T) -> Bool {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    do {
      let data = try encoder.encode(value)
      try FileHandle.standardOutput.write(contentsOf: data)
      try FileHandle.standardOutput.write(contentsOf: Data("\n".utf8))
      return true
    } catch {
      return false
    }
  }

  // MARK: - Signal handling & shutdown

  private func installSignalHandlers() {
    let sigsrc1 = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let sigsrc2 = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigsrc1.setEventHandler { [weak self] in self?.shutdown() }
    sigsrc2.setEventHandler { [weak self] in self?.shutdown() }
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    // Ignore SIGPIPE process-wide: when the parent dies abruptly
    // (SIGKILL on the CLI, terminal session torn down, parent crashed)
    // the OS closes the parent's read end of our stdout pipe. The next
    // heartbeat write would deliver SIGPIPE to us, and the default
    // handler is "terminate immediately" — which would kill us BEFORE
    // the shutdown path can finalise the WAV header, leaving a file
    // whose RIFF chunk size and data chunk size fields both say zero.
    // afinfo / audio players reject such files as "0 sec / 0 bytes"
    // even though the samples are physically on disk.
    //
    // With SIGPIPE ignored, the failing `write(2)` returns -1 with
    // errno=EPIPE instead of killing us. `tryPrintJSON` catches the
    // throw from FileHandle.write(contentsOf:) and `emitHeartbeat`
    // treats the failure as a request to shut down cleanly — same
    // path as SIGTERM/SIGINT.
    //
    // Scoped to the recorder process (not main.swift) so the events
    // subcommand keeps its current SIGPIPE-kill-on-orphan behaviour;
    // events has no file handles to finalise, so dying on broken pipe
    // is the right outcome there.
    signal(SIGPIPE, SIG_IGN)
    sigsrc1.resume()
    sigsrc2.resume()
    signalSources = [sigsrc1, sigsrc2]
  }

  private func shutdown() {
    // Re-entry guard. SIGTERM + SIGINT delivered back-to-back, or a
    // second SIGTERM from a impatient parent, must not double-tear-down.
    lock.lock()
    if stopping {
      lock.unlock()
      return
    }
    stopping = true
    lock.unlock()

    heartbeatTimer?.cancel()
    heartbeatTimer = nil

    if engine.isRunning {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    // Disabling VPIO in shutdown isn't strictly necessary — the
    // engine is going away — but it's cheap insurance against a
    // pathological re-init in the same process.
    try? engine.inputNode.setVoiceProcessingEnabled(false)

    if let stream = scStream {
      // SCStream's stopCapture is async; we wait synchronously on a
      // semaphore so the file close happens AFTER all in-flight
      // audio samples have been drained through the output handler.
      let sem = DispatchSemaphore(value: 0)
      Task {
        do {
          try await stream.stopCapture()
        } catch {
          let msg = "SCStream.stopCapture error: \(error.localizedDescription)\n"
          FileHandle.standardError.write(Data(msg.utf8))
        }
        sem.signal()
      }
      // Bounded wait so a misbehaving SCK can't hang shutdown.
      _ = sem.wait(timeout: .now() + .seconds(5))
    }
    scStream = nil
    scOutputHandler = nil

    // Releasing the AVAudioFile finalises the WAV header. Setting nil
    // explicitly is more defensive than relying on Swift's ARC at
    // exit() time — the global object reference would otherwise leak
    // through exit() without running deinit reliably.
    lock.lock()
    audioFile = nil
    let finalFrames = framesWritten
    lock.unlock()

    // Verify the file is readable + non-zero. Treat verification
    // failure as a non-zero exit so the TS wrapper knows the WAV is
    // suspect.
    if let err = verifyOutputFile() {
      let msg = "output WAV verification failed: \(err)\n"
      FileHandle.standardError.write(Data(msg.utf8))
      fflush(stdout)
      exit(1)
    }

    let elapsedMs = Int(Double(finalFrames) / TARGET_SAMPLE_RATE * 1000.0)
    let summary = ShutdownSummary(
      event: "stopped",
      frames: Int(finalFrames),
      durationMs: elapsedMs,
      outputPath: outputURL.path
    )
    // tryPrintJSON, not printJSON: if the parent died (the very
    // scenario that triggered this shutdown via EPIPE in
    // `emitHeartbeat`), the final summary write also EPIPEs. We don't
    // care — the wav header is already finalised by the time we get
    // here, which is the only durable side-effect that mattered.
    _ = tryPrintJSON(summary)
    fflush(stdout)
    stoppedSuccessfully = true
    exit(0)
  }

  /// Open the just-closed WAV file with AVAudioFile (read-only) to
  /// confirm a parseable header. Returns an error message on failure,
  /// nil on success.
  private func verifyOutputFile() -> String? {
    if !FileManager.default.fileExists(atPath: outputURL.path) {
      return "file does not exist at \(outputURL.path)"
    }
    let attrs = try? FileManager.default.attributesOfItem(atPath: outputURL.path)
    let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
    if size < 44 {
      return "file size \(size) bytes is below the WAV header minimum (44 bytes)"
    }
    do {
      _ = try AVAudioFile(forReading: outputURL)
    } catch {
      return "AVAudioFile(forReading:) rejected the file: \(error.localizedDescription)"
    }
    return nil
  }
}

/// SCStream output handler. Captures both `SCStreamOutput` (per-sample
/// callbacks) and `SCStreamDelegate` (stop-on-error). Conforms via
/// NSObject inheritance because both protocols require ObjC dynamic
/// dispatch.
private final class SystemAudioOutput: NSObject, SCStreamOutput, SCStreamDelegate {
  let onAudio: (CMSampleBuffer) -> Void
  init(onAudio: @escaping (CMSampleBuffer) -> Void) {
    self.onAudio = onAudio
  }

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    guard outputType == .audio else { return }
    onAudio(sampleBuffer)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let msg = "SCStream stopped with error: \(error.localizedDescription)\n"
    FileHandle.standardError.write(Data(msg.utf8))
    // Don't exit here — the recorder's signal handler is the single
    // shutdown owner. The next mic-driven write will see the empty
    // backlog and produce mic-only output.
  }
}

// MARK: - Payloads

private struct HeartbeatPayload: Encodable {
  let frames: Int
  let durationMs: Int
  let levelDbfs: Double

  enum CodingKeys: String, CodingKey {
    case frames
    case durationMs = "duration_ms"
    case levelDbfs = "level_dbfs"
  }
}

private struct ShutdownSummary: Encodable {
  let event: String
  let frames: Int
  let durationMs: Int
  let outputPath: String

  enum CodingKeys: String, CodingKey {
    case event
    case frames
    case durationMs = "duration_ms"
    case outputPath = "output_path"
  }
}

// MARK: - Errors

private struct RecorderError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

// MARK: - Argument parsing

private struct RecordArgs {
  let outputPath: String
  let captureSystemAudio: Bool
}

private func parseRecordArgs(_ args: [String]) -> RecordArgs? {
  var output: String?
  var systemAudio = false
  var i = 0
  while i < args.count {
    let a = args[i]
    switch a {
    case "--output":
      guard i + 1 < args.count else { return nil }
      output = args[i + 1]
      i += 2
    case "--system-audio":
      systemAudio = true
      i += 1
    default:
      // Unknown flag — surface as parse failure so the user sees
      // usage rather than a silent ignore.
      return nil
    }
  }
  guard let path = output, !path.isEmpty else { return nil }
  return RecordArgs(outputPath: path, captureSystemAudio: systemAudio)
}

// MARK: - Entry

func runRecord(args: [String]) {
  guard let parsed = parseRecordArgs(args) else {
    let msg = """
    usage: swrag-helper record --output <path> [--system-audio]
    """
    FileHandle.standardError.write(Data(msg.utf8))
    FileHandle.standardError.write(Data("\n".utf8))
    exit(2)
  }
  let url = URL(fileURLWithPath: parsed.outputPath)
  let recorder: Recorder
  do {
    recorder = try Recorder(outputURL: url, captureSystemAudio: parsed.captureSystemAudio)
    try recorder.startBlocking()
  } catch let e as RecorderError {
    FileHandle.standardError.write(Data("record: \(e.message)\n".utf8))
    exit(1)
  } catch {
    FileHandle.standardError.write(Data("record: \(error.localizedDescription)\n".utf8))
    exit(1)
  }
  // The recorder is running. Hand the main thread off to the runloop
  // so the dispatch sources on `.main` (signal handlers + heartbeat
  // timer) can fire. RunLoop.main.run() blocks the main thread until
  // `exit()` is called from the SIGTERM/SIGINT handler in `shutdown()`.
  // Keeping a reference to `recorder` here is important — ARC would
  // otherwise see it as unused and might tear it down. The compiler
  // is conservative enough that the implicit retain via the catch
  // block above is usually sufficient, but the explicit `_ =` makes
  // the intent obvious to future readers.
  _ = recorder
  RunLoop.main.run()
}
