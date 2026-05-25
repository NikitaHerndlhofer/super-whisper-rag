/**
 * macOS popup + notification surface for the meeting capture daemon.
 *
 * Two functions, both reachable from `daemon.ts`. Both fire native
 * UNUserNotificationCenter banners via `swrag-helper notify`. v0.9.6
 * collapsed each banner to a single action button — see the README's
 * "About the meeting watcher" section for the user-facing rationale,
 * and the inline comment on each function for the wire mapping.
 *
 *   - `askStartRecording({ reason })` — banner with one action,
 *     `Record`. Dismiss / timeout (60 s default) maps to `"skip"` —
 *     the user expressed no interest in this meeting, so don't
 *     record. Returns `"record" | "skip"`.
 *
 *   - `askStopRecording({ elapsedSec })` — banner with one action,
 *     `Stop & save`. Dismiss / timeout (60 s default) maps to
 *     `"keep"` — the user is still in the conversation, keep the
 *     recorder running. Returns `"save" | "keep"`.
 *
 * Why a single action? macOS Tahoe (and earlier) only renders inline
 * action buttons on the banner when the notification has one action;
 * two or more actions are hidden behind the "Options" dropdown unless
 * the user has notification style set to "Alerts" (which most people
 * don't). One action keeps the affirmative path one click away
 * regardless of style. The negative path (skip / keep) is implicit:
 * dismiss the notification, or let it time out.
 *
 * v0.9.0 swapped the start-recording prompt from `osascript display
 * dialog` (modal, focus-stealing) to a UNUserNotificationCenter
 * banner. The native banner has affordances osascript doesn't:
 *   - Honors macOS Focus / Do Not Disturb settings.
 *   - Persists in Notification Center if missed.
 *   - Doesn't steal focus from the current meeting tool.
 *   - Shows the same way regardless of which Space the user is on.
 *
 * v0.9.6 promoted the stop path onto the same native-banner stack so
 * the two surfaces stay symmetric. The pre-v0.9.6 `notifyAutoStopped`
 * osascript banner is gone — it had no action buttons, and the
 * menu-bar `Undo` window was unintuitive (decision lived three clicks
 * away, in a different UI surface, with a five-second timer).
 *
 * Both run external commands, but the actual exec / spawn is an
 * injectable dependency so tests don't fire real banners.
 */
import {
  fireStartRecordingNotification as defaultFireStartRecording,
  fireStopRecordingNotification as defaultFireStopRecording,
  type FireStartRecordingNotificationOptions,
  type FireStopRecordingNotificationOptions,
  type StartNotifyResult,
  type StopNotifyResult,
} from "../mac/helper.ts";
import { verbose, warn } from "../log.ts";

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Daemon-facing outcomes. `"skip"` is the implicit dismiss/timeout
 * branch — the wire-side helper only ever emits `"Record"` or
 * `"timeout"`, and `askStartRecording` maps `"timeout"` to `"skip"`
 * before returning.
 */
export type StartChoice = "record" | "skip";

/**
 * Daemon-facing outcomes. `"keep"` is the implicit dismiss/timeout
 * branch — the wire-side helper only ever emits `"Stop & save"` or
 * `"timeout"`, and `askStopRecording` maps `"timeout"` to `"keep"`
 * before returning. The discard path moved out of the banner in
 * v0.9.6 — users discard via the menu bar or
 * `swrag meeting queue discard <id>` after the recording has been
 * saved to the queue.
 */
export type StopChoice = "save" | "keep";

export interface AskStartOptions {
  /** Reason shown to the user; e.g. "Meeting detected — Zoom is frontmost…". */
  reason: string;
  /**
   * Override the timeout in seconds. Defaults to 60. Tests use a
   * sub-second value so they don't actually wait. v0.9.6 dropped
   * this from 90 → 60: dismiss/timeout no longer triggers an
   * action, so a long deadline only delays the implicit skip.
   */
  giveUpAfterSec?: number;
  /**
   * Inject a notification firing function for tests. Defaults to
   * `fireStartRecordingNotification` from `src/mac/helper.ts` which
   * spawns the Swift helper's `notify` subcommand.
   */
  fireNotification?: typeof defaultFireStartRecording;
  /**
   * @deprecated — Pre-v0.9.0 hook for the `osascript display dialog`
   * exec. Still accepted for backwards-compatible test scaffolds, but
   * unused on the new banner code path. New tests should pass
   * `fireNotification` instead.
   */
  exec?: ExecFn;
}

export interface AskStopOptions {
  /**
   * Elapsed recording time at the moment the daemon asks; rendered
   * into the body as "(elapsed M:SS)" so the user has context for
   * which recording is being asked about.
   */
  elapsedSec: number;
  /**
   * Override the timeout in seconds. Defaults to 60. On timeout the
   * caller treats the outcome as "keep" — see the module header.
   */
  giveUpAfterSec?: number;
  /**
   * Inject a notification firing function for tests. Defaults to
   * `fireStopRecordingNotification` from `src/mac/helper.ts`.
   */
  fireNotification?: typeof defaultFireStopRecording;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Minimal exec-like contract. Production passes a thin `Bun.spawn`
 * wrapper; tests pass a stub that records calls and returns canned
 * results. Unused on the post-v0.9.0 banner code path; retained as
 * a type so legacy test scaffolds still compile.
 */
export type ExecFn = (cmd: string[]) => Promise<ExecResult>;

/* -------------------------------------------------------------------------- */
/* askStartRecording                                                          */
/* -------------------------------------------------------------------------- */

const DEFAULT_GIVE_UP_AFTER_SEC = 60;

/**
 * Fire a native banner notification asking the user whether to start
 * recording the current meeting. Wire-level outcomes:
 *   - helper prints `Record` → user clicked Record (or the banner
 *     body, which defaults to Record).
 *   - helper prints `timeout` → banner auto-dismissed or the user
 *     swiped it away. We map this to `"skip"`.
 *
 * Any error (auth denied, spawn failure, schema mismatch on stdout)
 * is surfaced via `warn()` and degraded to `"skip"`. We never want a
 * notification failure to take the daemon down or accidentally start
 * recording without consent.
 */
export async function askStartRecording(opts: AskStartOptions): Promise<StartChoice> {
  const giveUpAfter = opts.giveUpAfterSec ?? DEFAULT_GIVE_UP_AFTER_SEC;
  const fire = opts.fireNotification ?? defaultFireStartRecording;
  const fireOpts: FireStartRecordingNotificationOptions = {
    reason: opts.reason,
    timeoutSeconds: giveUpAfter,
  };
  let result: StartNotifyResult;
  try {
    result = await fire(fireOpts);
  } catch (e) {
    warn(
      `askStartRecording: notification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "skip";
  }
  verbose(`askStartRecording: notify result=${result}`);
  return result === "Record" ? "record" : "skip";
}

/* -------------------------------------------------------------------------- */
/* askStopRecording                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Fire a native banner notification asking the user whether to stop
 * the current recording after a debounce-confirmed `HIGH → NONE`
 * mic edge. Wire-level outcomes:
 *   - helper prints `Stop & save` → user clicked Stop & save (or
 *     the banner body, which defaults to that action). Caller stops
 *     the recorder and enqueues the wav.
 *   - helper prints `timeout` → banner auto-dismissed or the user
 *     swiped it away. We map this to `"keep"`. Caller does nothing;
 *     recording continues. The next `HIGH → NONE` debounce edge
 *     will re-fire the banner if the user has actually stopped.
 *
 * Same failure semantics as `askStartRecording`: any error
 * (auth denied, spawn failure, malformed stdout) degrades to
 * `"keep"`. Losing data is worse than asking again.
 */
export async function askStopRecording(opts: AskStopOptions): Promise<StopChoice> {
  const giveUpAfter = opts.giveUpAfterSec ?? DEFAULT_GIVE_UP_AFTER_SEC;
  const fire = opts.fireNotification ?? defaultFireStopRecording;
  const fireOpts: FireStopRecordingNotificationOptions = {
    elapsedSec: opts.elapsedSec,
    timeoutSeconds: giveUpAfter,
  };
  let result: StopNotifyResult;
  try {
    result = await fire(fireOpts);
  } catch (e) {
    warn(
      `askStopRecording: notification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "keep";
  }
  verbose(`askStopRecording: notify result=${result}`);
  return result === "Stop & save" ? "save" : "keep";
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Defensively escape characters that would break out of an inner
 * double-quoted AppleScript string. Unused on the post-v0.9.0 banner
 * code path; retained as an exported helper for tests + any
 * downstream consumer that still builds AppleScript strings.
 */
export function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
