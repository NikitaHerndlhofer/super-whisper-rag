/**
 * Query the active browser tab's URL via `osascript`.
 *
 * macOS has no event API for "the front browser's active-tab URL changed".
 * Browsers don't post notifications and AppleScript cannot subscribe. So
 * the URL query is the one unavoidable synchronous shell-out in the
 * detection path — but it fires only on relevant events (a frontmost
 * change to a known browser, or a mic_changed while a browser is
 * frontmost), never on a timer.
 *
 * Each known browser has its own AppleScript dialect:
 *   - Safari:    `URL of current tab of front window`
 *   - Chromium-family (Chrome, Brave, Vivaldi, Edge, Comet):
 *                `URL of active tab of front window`
 *   - Arc:       `URL of active tab of front window` (same as Chromium-family;
 *                Arc inherits The Browser Company's WebKit-Chromium shape).
 *   - Comet:     `URL of active tab of front window` (Perplexity's Chromium
 *                fork; verified to accept the Chrome dialect verbatim).
 *
 * Failure modes (all return null — this is a soft signal):
 *   - bundleId not in our table
 *   - Apple Events permission denied
 *   - Browser not running / no front window / no active tab
 *   - osascript timed out
 *   - any AppleScript runtime error
 *
 * Returns `string | null`. We deliberately do NOT throw — callers
 * decide what to do with absence (the detector treats null as "no
 * browser URL signal", same as a non-meeting URL).
 */
import { z } from "zod";

const URL_QUERY_TIMEOUT_MS = 1_500;

/**
 * Dispatch table mapping bundle ID to its osascript dialect.
 *
 * Kept as exported `as const` so tests can assert the table contents
 * without re-implementing the dispatch. The `appName` field is the
 * literal that goes into `tell application "X"`.
 */
export const BROWSER_OSASCRIPT_DIALECTS = {
  "com.apple.Safari": {
    appName: "Safari",
    script: 'tell application "Safari" to return URL of current tab of front window',
  },
  "com.google.Chrome": {
    appName: "Google Chrome",
    script: 'tell application "Google Chrome" to return URL of active tab of front window',
  },
  "com.brave.Browser": {
    appName: "Brave Browser",
    script: 'tell application "Brave Browser" to return URL of active tab of front window',
  },
  "company.thebrowser.Browser": {
    appName: "Arc",
    script: 'tell application "Arc" to return URL of active tab of front window',
  },
  "com.vivaldi.Vivaldi": {
    appName: "Vivaldi",
    script: 'tell application "Vivaldi" to return URL of active tab of front window',
  },
  "com.microsoft.edgemac": {
    appName: "Microsoft Edge",
    script: 'tell application "Microsoft Edge" to return URL of active tab of front window',
  },
  "ai.perplexity.comet": {
    appName: "Comet",
    script: 'tell application "Comet" to return URL of active tab of front window',
  },
} as const;

export type BrowserBundleId = keyof typeof BROWSER_OSASCRIPT_DIALECTS;

export function isKnownBrowser(bundleId: string): bundleId is BrowserBundleId {
  return bundleId in BROWSER_OSASCRIPT_DIALECTS;
}

/**
 * The URL string itself is validated through this schema after we
 * strip whitespace from osascript's stdout. We don't enforce a full
 * URL parser here — osascript can return `missing value` on a
 * front-window-but-no-tab situation and we want to map that to null,
 * not throw.
 */
const NonEmptyStringSchema = z.string().min(1);

export interface GetBrowserUrlOptions {
  /** Test hook: replace the spawn implementation. */
  spawn?: typeof Bun.spawn;
  /** Per-call timeout in ms (default 1500). */
  timeoutMs?: number;
}

/**
 * Fetch the active-tab URL of the given browser. Returns null on any
 * failure (unknown bundle, permission denied, no front window, error).
 */
export async function getBrowserUrl(
  bundleId: string,
  opts: GetBrowserUrlOptions = {},
): Promise<string | null> {
  if (!isKnownBrowser(bundleId)) return null;
  const dialect = BROWSER_OSASCRIPT_DIALECTS[bundleId];
  const spawn = opts.spawn ?? Bun.spawn;
  const timeoutMs = opts.timeoutMs ?? URL_QUERY_TIMEOUT_MS;
  try {
    const proc = spawn(["osascript", "-e", dialect.script], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
    });
    const [stdout, _stderr] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
    ]);
    const exit = await proc.exited;
    if (exit !== 0) return null;
    const trimmed = stdout.trim();
    // osascript emits literal `missing value` when the app is running
    // but has no front window or no active tab. Treat as null.
    if (trimmed === "missing value" || trimmed === "") return null;
    const parsed = NonEmptyStringSchema.safeParse(trimmed);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
