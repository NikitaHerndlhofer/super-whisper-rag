# Phase 3 recorder — VPIO smoke test

Phase 3's mic path goes through `AVAudioEngine` with VoiceProcessingIO
enabled (Apple's stock `kAudioUnitSubType_VoiceProcessingIO`). VPIO
gives us echo cancellation, AGC, and noise suppression for free, but
the activation is subtle: it has to be enabled BEFORE
`engine.start()`, and Apple offers no API to introspect at runtime
whether AEC is actually running. The closest we can get to verifying
the pipeline is a manual A/B listen.

This document is the smoke test we run after touching anything in
`swift-helper/Sources/SwragHelper/Record.swift` or the surrounding
TS lifecycle.

## What we're verifying

When the user is on speakers in a call, the remote party's voice plays
back through the speakers. Without AEC, the mic picks that audio up;
the resulting transcript double-counts what the remote party said
(once from system audio, once from the leaked mic). VPIO cancels that
leakage against the live system-output reference. If VPIO is
misconfigured (wrong activation order, wrong format, race with
SCStream), the speaker audio appears in the recorded wav unchanged.

## Setup

1. **Disable system-audio capture** for this test. We want a mic-only
   recording so the only path the remote audio could land in the wav
   is via the speaker → mic leak — which is exactly what VPIO is
   supposed to kill.
2. Pick a known-loud audio clip with clear speech (a podcast intro
   works well). Have its path handy.
3. Open System Settings → Sound and set your output to the **built-in
   speakers** (not headphones). VPIO's AEC needs the audio playing
   back through a speaker that physically reaches the mic.
4. Confirm Microphone permission is granted to your terminal /
   shell.

## Procedure

1. Start the clip playing through speakers at conversational volume
   (loud enough that you can clearly hear it 1–2 m from the mic, but
   not so loud the room shakes). Let it run for 10 s before starting
   the recorder so VPIO has a stable reference signal.
2. In a separate terminal, start the recorder:

   ```bash
   bun run src/cli.ts meeting record start --label "phase3-vpio-test"
   ```

   (or `swrag meeting record start --label …` if you've installed via
   Homebrew or `bun run build`.)

3. Speak normally for ~15 seconds, varying your voice in pitch and
   volume so the wav has dynamic range. Don't try to talk over the
   clip — just talk past it.
4. Hit `Ctrl-C` to stop. The CLI prints the queue row id and the
   wav path.
5. Pause the clip.
6. Play back the resulting wav:

   ```bash
   afplay <path-printed-above>
   ```

   (The path lives under
   `~/Library/Application Support/superwhisper-rag/meetings/incoming/`
   and looks like `<unix-ts>-<short-uuid>.wav`.)

## Pass / fail

**Pass**: your voice is clearly audible; the audio clip is either
inaudible or heavily attenuated (you might hear faint residue,
especially during silences in your own speech). VPIO is working.

**Fail**: the audio clip plays back through the recording at roughly
the volume it played from your speakers. VPIO is NOT cancelling the
output → mic leak. Possible causes:

- `setVoiceProcessingEnabled(true)` was called after `engine.start()`
  (must be before).
- The input node's format was changed after VPIO activation (every
  format change invalidates the AEC reference).
- The output node isn't initialised before the tap installs — VPIO
  needs the output as the reference channel for AEC. If we ever
  refactor to skip the engine's default output, we'll need to
  explicitly construct one.
- The mic and system output are on completely separate audio devices
  (e.g. an external USB mic and a different audio output): AEC works
  best when the same audio fabric handles both. The "speakers + built-in
  mic" path on a MacBook is the canonical happy path.

## Recording the result

After a successful test, jot the date + macOS version + Mac model into
the spike doc (`docs/sw-patcher-spike.md`) so future revisions can see
which configurations VPIO is known-good on.

## Related

- The system-audio mixing path is separately code-reviewed because
  it requires Screen Recording permission to exercise end-to-end —
  which we deliberately don't fire in automated tests (would pop a
  permission dialog).
- VPIO docs:
  <https://developer.apple.com/documentation/avfaudio/avaudioenginenodevoiceprocessing>
- The headline rationale for VPIO is in the plan file (Phase 3
  section, "system-audio-leaking-through-speakers double-count").
