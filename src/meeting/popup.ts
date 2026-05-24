/**
 * macOS popup + notification surface for the meeting capture daemon.
 *
 * Two functions, both reachable from `daemon.ts`:
 *
 *   - `askStartRecording({ reason })` — fires a native banner via
 *     `swrag-helper notify` (UNUserNotificationCenter), buttons:
 *     {Record, Skip}, auto-dismiss after 90 s. Returns
 *     `"record" | "skip" | "timeout"`. The banner is non-modal: it
 *     slides in from the top-right and the user can ignore it without
 *     losing focus on whatever meeting tool they're already in.
 *
 *   - `notifyAutoStopped({ wavPath, queueRowId })` — `osascript
 *     display notification`, non-modal banner. The undo window itself
 *     (5 s) is tracked in the daemon's status state — this function
 *     just nudges the user that the wav was saved and points them at
 *     the menu bar.
 *
 * v0.9.0 swapped the start-recording prompt from `osascript display
 * dialog` (modal, focus-stealing) to a UNUserNotificationCenter
 * banner. The native banner has affordances osascript doesn't:
 *   - Honors macOS Focus / Do Not Disturb settings.
 *   - Persists in Notification Center if missed.
 *   - Doesn't steal focus from the current meeting tool.
 *   - Shows the same way regardless of which Space the user is on.
 *
 * notifyAutoStopped stays on `osascript display notification` for
 * symmetry with the previous behaviour — it's a fire-and-forget
 * single-line notice with no action buttons, where the only real
 * difference (no FocusManager support in osascript) is a non-issue
 * because auto-stop is itself an end-of-meeting event.
 *
 * Both run external commands, but the actual exec / spawn is an
 * injectable dependency so tests don't fire real banners or dialogs.
 */
import {
  fireStartRecordingNotification as defaultFireStartRecording,
  type FireStartRecordingNotificationOptions,
  type NotifyResult,
} from "../mac/helper.ts";
import { verbose, warn } from "../log.ts";

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export type StartChoice = "record" | "skip" | "timeout";

export interface AskStartOptions {
  /** Reason shown to the user; e.g. "Meeting detected — Zoom is frontmost…". */
  reason: string;
  /**
   * Override the timeout in seconds. Defaults to 90 (per the design
   * review). Tests use a sub-second value so they don't actually wait.
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

export interface NotifyOptions {
  wavPath: string;
  queueRowId: number;
  /** Inject an exec for tests; defaults to the real `osascript`. */
  exec?: ExecFn;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Minimal exec-like contract. Production passes a thin `Bun.spawn`
 * wrapper; tests pass a stub that records calls and returns canned
 * results. Returns the unparsed stdout/stderr exactly as macOS's
 * osascript emits them — the parsing happens in this module.
 */
export type ExecFn = (cmd: string[]) => Promise<ExecResult>;

/* -------------------------------------------------------------------------- */
/* askStartRecording                                                          */
/* -------------------------------------------------------------------------- */

const DEFAULT_GIVE_UP_AFTER_SEC = 90;

/**
 * Fire a native banner notification asking the user whether to start
 * recording the current meeting. Returns:
 *   - `"record"` if the user clicked the Record action button (or
 *     the banner body, which defaults to Record).
 *   - `"skip"` if the user clicked Skip.
 *   - `"timeout"` if the banner auto-dismissed or the user swiped
 *     it away.
 *
 * Errors from the helper (auth denied, spawn failure, schema mismatch
 * on stdout) are surfaced via `warn()` and degraded to `"timeout"`
 * — we never want a notification failure to take the daemon down or
 * accidentally start recording without consent.
 */
export async function askStartRecording(opts: AskStartOptions): Promise<StartChoice> {
  const giveUpAfter = opts.giveUpAfterSec ?? DEFAULT_GIVE_UP_AFTER_SEC;
  const fire = opts.fireNotification ?? defaultFireStartRecording;
  const fireOpts: FireStartRecordingNotificationOptions = {
    reason: opts.reason,
    timeoutSeconds: giveUpAfter,
  };
  let result: NotifyResult;
  try {
    result = await fire(fireOpts);
  } catch (e) {
    warn(
      `askStartRecording: notification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "timeout";
  }
  verbose(`askStartRecording: notify result=${result}`);
  return result;
}

/* -------------------------------------------------------------------------- */
/* notifyAutoStopped                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Fire a non-modal notification banner announcing the auto-stop.
 * Body mentions "saved" and "undo via menu bar within 5 s" — the
 * actual undo window is owned by the daemon, this function only
 * informs the user.
 *
 * Errors are logged but never thrown — losing a notification is
 * cosmetic; losing the daemon over a notification failure is not.
 */
export async function notifyAutoStopped(opts: NotifyOptions): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  const title = "Meeting recording saved";
  const subtitle = "Auto-stopped — undo via menu bar within 5 s";
  // Embed the wav basename in the message so multiple stacked
  // notifications stay distinguishable. Path is wrapped in
  // escapeForAppleScript to defang quotes / backslashes in
  // unexpected filenames.
  const basename = opts.wavPath.split("/").pop() ?? opts.wavPath;
  const body = `Saved ${escapeForAppleScript(basename)} (queue id ${opts.queueRowId})`;
  const script =
    `display notification "${body}" with title "${escapeForAppleScript(title)}" ` +
    `subtitle "${escapeForAppleScript(subtitle)}"`;
  try {
    const r = await exec(["osascript", "-e", script]);
    if (r.exitCode !== 0) {
      warn(`notifyAutoStopped: osascript exit=${r.exitCode} stderr=${r.stderr.trim()}`);
    }
  } catch (e) {
    warn(`notifyAutoStopped failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Defensively escape characters that would break out of the inner
 * double-quoted AppleScript string. We only call this for strings the
 * daemon constructs from app names / paths / our own reason text — but
 * defending against backslashes and quotes here is cheap insurance.
 *
 * Exposed for testing.
 */
export function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const DEFAULT_EXEC: ExecFn = async (cmd: string[]): Promise<ExecResult> => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

const defaultExec = DEFAULT_EXEC;
