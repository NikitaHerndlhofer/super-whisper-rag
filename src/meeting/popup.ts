/**
 * macOS popup + notification surface for the meeting capture daemon.
 *
 * Two functions, both reachable from `daemon.ts`:
 *
 *   - `askStartRecording({ reason })` — `osascript display dialog` with
 *     `giving up after 90`. Buttons: {"Skip","Record"}, default
 *     "Record". Fires on debounce-confirmed NONE → HIGH while we're
 *     not already recording. The 90 s timeout comes from the Phase 4
 *     design review (bumped from the initial 30 s for ergonomics —
 *     longer ramp-up time on slow-starting calls is forgiving).
 *
 *   - `notifyAutoStopped({ wavPath, queueRowId })` — `osascript
 *     display notification`, non-modal banner. The undo window itself
 *     (5 s) is tracked in the daemon's status state — this function
 *     just nudges the user that the wav was saved and points them at
 *     the menu bar.
 *
 * Both run an external command (`osascript`) but the actual exec is
 * an injectable dependency so tests don't fire real dialogs.
 *
 * Output parsing for `display dialog`:
 *   Normal click   → exit 0, stdout `button returned:Record, gave up:false`
 *   Timeout        → exit 0, stdout `button returned:, gave up:true`
 *   `Cancel` press → exit 1, stderr `User canceled.`
 *
 * We avoid a Cancel button on purpose — "Skip" reads cleaner and
 * keeps the result vocabulary to record / skip / timeout. If the
 * user closes the dialog window (cmd-W on the standby) we treat it
 * as a skip (the dialog returns no button and gave_up:false).
 */
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
  /** Inject an exec for tests; defaults to the real `osascript`. */
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
 * Fire a modal start-recording prompt. Returns:
 *   - `"record"` if the user clicked "Record"
 *   - `"skip"` if the user clicked "Skip" or dismissed the dialog
 *   - `"timeout"` if the dialog gave up after the timeout
 *
 * Errors from osascript (other than `User canceled.`) are surfaced
 * via `warn()` and treated as `"skip"` — we never want a popup
 * failure to take the daemon down or accidentally record without
 * consent.
 */
export async function askStartRecording(opts: AskStartOptions): Promise<StartChoice> {
  const giveUpAfter = opts.giveUpAfterSec ?? DEFAULT_GIVE_UP_AFTER_SEC;
  const exec = opts.exec ?? defaultExec;
  const reason = escapeForAppleScript(opts.reason);
  // We intentionally drop the dialog title (the default `osascript`
  // title is fine) and rely on the "Record" default-button visual
  // for affordance. `with icon caution` is loud — keep it as the
  // default informational icon.
  const script =
    `display dialog "${reason}" buttons {"Skip","Record"} default button "Record" ` +
    `giving up after ${giveUpAfter}`;
  const r = await exec(["osascript", "-e", script]);
  if (r.exitCode !== 0) {
    // User pressed escape / closed the window without a button (rare —
    // there's no cancel button — but possible via cmd-period on some
    // configurations). Surface as a skip rather than an exception.
    const stderr = r.stderr.trim();
    if (stderr.includes("User canceled")) {
      return "skip";
    }
    warn(`askStartRecording: osascript exit=${r.exitCode} stderr=${stderr}`);
    return "skip";
  }
  const parsed = parseDialogOutput(r.stdout);
  verbose(`askStartRecording: ${JSON.stringify(parsed)}`);
  if (parsed.gaveUp) return "timeout";
  if (parsed.button === "Record") return "record";
  // Empty button + gaveUp:false means the dialog was dismissed without
  // a button (cmd-W) — treat as skip for safety.
  return "skip";
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
 * `display dialog` stdout shape: `button returned:Record, gave up:false`.
 * Some macOS versions may swap the order of fields, so we don't rely
 * on positional parsing — both fields are matched by regex.
 *
 * Exposed for testing.
 */
export function parseDialogOutput(stdout: string): { button: string; gaveUp: boolean } {
  const buttonMatch = stdout.match(/button returned:([^,\n]*)/);
  const gaveUpMatch = stdout.match(/gave up:(true|false)/);
  const button = buttonMatch ? (buttonMatch[1] ?? "").trim() : "";
  const gaveUp = gaveUpMatch ? gaveUpMatch[1] === "true" : false;
  return { button, gaveUp };
}

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
