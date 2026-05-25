/**
 * Event-driven meeting detector.
 *
 * Consumes the line-delimited JSON event stream from `swrag-helper
 * events` (see `src/mac/helper.ts::spawnEventsHelper`) and maintains
 * an internal state machine. Output is a `MeetingSignal`:
 *
 *   - HIGH:   mic in use AND any of:
 *               · frontmost is a known call app (strict or soft)
 *               · frontmost is a browser AND its URL matches a meeting pattern
 *               · a strict call app is running anywhere (Zoom in the background
 *                 while you're typing in Notes still counts)
 *   - MEDIUM: mic in use alone (probably dictation — logged, no popup later)
 *   - NONE:   otherwise
 *
 * "Mic in use" is EFFECTIVE: the helper's raw `mic.in_use` bit is the
 * floor, but if the helper also reports `mic.owners`, we filter out
 * our own recorder subprocess (bundle id `ai.swrag.helper`) before
 * deciding. Without this filter, the moment our `swrag-helper record`
 * subprocess starts capturing the mic, every other audio client could
 * close the device and the device-level `kAudioDevicePropertyDevice
 * IsRunningSomewhere` would still report true (because we're holding
 * it) — masking the "meeting ended" HIGH → NONE transition and
 * preventing the stop-recording banner from firing. See v0.9.8
 * notes for the full story.
 *
 * Debounce, not hysteresis: an edge (NONE→HIGH or HIGH→NONE) is held
 * for 1500 ms before being committed to subscribers. Mid-call device
 * switches that flicker the mic-in-use bit for <1.5 s are filtered
 * without per-poll counting.
 *
 * Browser URL is the one synchronous query in detection. It fires
 * only when the new state's signal would benefit from URL evidence
 * (mic in use, frontmost is a browser, and we don't already have
 * HIGH evidence from a running call app). The query is async on the
 * detector's side — `handleEvent` returns a Promise so callers must
 * await it. We NEVER poll the URL on a timer.
 *
 * The "stale browser URL" concern (user closes Meet tab without
 * changing frontmost) is handled by the mic-release event, not by
 * URL polling: when the meeting app releases the mic, CoreAudio
 * fires a `mic_changed` event whose new owners list no longer
 * includes the meeting app; after the recorder-PID filter, effective
 * mic_in_use becomes false and the detector transitions HIGH → NONE.
 * The cached browser_url is cosmetic on the diagnostic side and
 * non-load-bearing for the decision; the next snapshot or frontmost
 * change re-queries it. Event-driven, no setInterval.
 */
import { z } from "zod";
import { verbose, warn } from "../log.ts";
import { getBrowserUrl, isKnownBrowser } from "../mac/browser-url.ts";
import type { EventLine } from "../mac/helper.ts";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bundle identifiers belonging to swrag itself. When the mic owners
 * list from CoreAudio includes any of these, we filter them out
 * before evaluating the effective `mic_in_use` bit — otherwise our
 * own recorder subprocess masks the meeting-end transition. The
 * recorder, the long-running events helper, the menubar's
 * notification, and any one-shot probes all share the same bundle
 * id (`ai.swrag.helper`), so a single-string filter covers every
 * swrag process that might hold the mic.
 */
export const SWRAG_OWNER_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "ai.swrag.helper",
]);

export const STRICT_CALL_APPS: ReadonlySet<string> = new Set([
  "us.zoom.xos",
  "com.microsoft.teams2",
  "com.microsoft.teams",
  "com.apple.FaceTime",
]);

export const SOFT_CALL_APPS: ReadonlySet<string> = new Set([
  "com.tinyspeck.slackmacgap",
  "com.hnc.Discord",
]);

export const BROWSERS: ReadonlySet<string> = new Set([
  "com.apple.Safari",
  "com.google.Chrome",
  "com.brave.Browser",
  "company.thebrowser.Browser",
  "com.vivaldi.Vivaldi",
  "com.microsoft.edgemac",
  "ai.perplexity.comet",
]);

/**
 * Path-required URL patterns. The leading anchors plus the path
 * segment ensure that landing on a meeting service's homepage (e.g.
 * `https://meet.google.com/about`) does NOT match — we only count
 * URLs that look like an actual room URL.
 *
 * Google Meet room IDs are three lowercase trigrams separated by
 * dashes (e.g. `meet.google.com/abc-defg-hij`). Teams uses a
 * `meetup-join` segment. Zoom uses `j/<digits>` or `wc/<digits>`.
 * Slack huddles surface as `app.slack.com/client/<workspace>/<channel>?…huddle…`.
 * Discord channel URLs always have a numeric channel id after
 * `channels/<guild>/<channel>`.
 */
export const MEETING_URL_PATTERNS: readonly RegExp[] = [
  /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/,
  /^https:\/\/teams\.(microsoft|live)\.com\/(l\/meetup-join|_#\/.+meetup-join)/,
  /^https:\/\/([^.]+\.)?zoom\.us\/(j|wc)\/\d+/,
  /^https:\/\/whereby\.com\/[^/]+/,
  /^https:\/\/app\.gather\.town\/app\//,
  /^https:\/\/app\.slack\.com\/client\/[A-Z0-9]+\/[A-Z0-9]+.*huddle/,
  /^https:\/\/discord\.com\/channels\//,
];

const DEFAULT_DEBOUNCE_MS = 1_500;

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

export const MeetingConfidenceSchema = z.enum(["HIGH", "MEDIUM", "NONE"]);
export type MeetingConfidence = z.infer<typeof MeetingConfidenceSchema>;

export const MeetingSignalSchema = z.object({
  confidence: MeetingConfidenceSchema,
  reason: z.string(),
  evidence: z.object({
    mic_in_use: z.boolean(),
    frontmost_bundle_id: z.string().nullable(),
    running_call_apps_strict: z.array(z.string()),
    running_call_apps_soft: z.array(z.string()),
    browser_url: z.string().nullable(),
    browser_url_matches: z.boolean(),
  }),
});
export type MeetingSignal = z.infer<typeof MeetingSignalSchema>;

export interface MeetingEdge {
  from: MeetingConfidence;
  to: MeetingConfidence;
  signal: MeetingSignal;
}

/* -------------------------------------------------------------------------- */
/* Detector                                                                   */
/* -------------------------------------------------------------------------- */

export interface DetectorOptions {
  /** Override the debounce window. */
  debounceMs?: number;
  /**
   * Replace the browser URL resolver. Tests inject a stub that returns
   * synchronous canned values; production passes nothing (uses
   * `getBrowserUrl`).
   */
  resolveBrowserUrl?: (bundleId: string) => Promise<string | null>;
  /** Called every time an edge is committed (after debounce). */
  onEdge?: (edge: MeetingEdge) => void;
}

interface InternalState {
  frontmostBundleId: string | null;
  frontmostName: string | null;
  micInUse: boolean;
  micOwners: string[];
  runningCallAppsStrict: Set<string>;
  runningCallAppsSoft: Set<string>;
  browserUrl: string | null;
}

/**
 * Pure helper — no debouncing, no state ownership. Exposed so tests
 * (and ad-hoc CLI diagnostics) can pass in a snapshot and read out the
 * signal. The instance method `MeetingDetector.signal()` calls into
 * this with its accumulated state.
 *
 * `micOwners` is optional. If omitted (e.g. legacy test fixtures
 * built before v0.9.8), we degrade to treating `micInUse` as the
 * truth. If present and empty (older macOS or CoreAudio query
 * failure), we also degrade — the mic-in-use bit alone has to do
 * the work. If present and non-empty, we filter out our own bundle
 * ids and use the external-owner count as the gate: zero external
 * owners → effective mic-in-use is false, regardless of the raw bit
 * (which our recorder process is holding open).
 */
export function computeSignal(state: {
  frontmostBundleId: string | null;
  micInUse: boolean;
  micOwners?: readonly string[];
  runningCallAppsStrict: ReadonlySet<string> | string[];
  runningCallAppsSoft: ReadonlySet<string> | string[];
  browserUrl: string | null;
}): MeetingSignal {
  const strictRunning = toArray(state.runningCallAppsStrict);
  const softRunning = toArray(state.runningCallAppsSoft);
  const browserUrlMatches =
    state.browserUrl != null && MEETING_URL_PATTERNS.some((re) => re.test(state.browserUrl ?? ""));
  const effectiveMicInUse = computeEffectiveMicInUse(state.micInUse, state.micOwners);

  if (!effectiveMicInUse) {
    return {
      confidence: "NONE",
      reason: state.micInUse ? "mic held only by swrag (no external owner)" : "mic not in use",
      evidence: {
        mic_in_use: false,
        frontmost_bundle_id: state.frontmostBundleId,
        running_call_apps_strict: strictRunning,
        running_call_apps_soft: softRunning,
        browser_url: state.browserUrl,
        browser_url_matches: browserUrlMatches,
      },
    };
  }

  // mic_in_use is the floor for HIGH. Now check for corroborating evidence.
  const fb = state.frontmostBundleId;
  let highReason: string | null = null;
  if (fb != null && (STRICT_CALL_APPS.has(fb) || SOFT_CALL_APPS.has(fb))) {
    highReason = `mic + frontmost is call app (${fb})`;
  } else if (fb != null && BROWSERS.has(fb) && browserUrlMatches) {
    highReason = `mic + frontmost browser on meeting URL`;
  } else if (strictRunning.length > 0) {
    highReason = `mic + strict call app running (${strictRunning.join(",")})`;
  }

  if (highReason != null) {
    return {
      confidence: "HIGH",
      reason: highReason,
      evidence: {
        mic_in_use: true,
        frontmost_bundle_id: state.frontmostBundleId,
        running_call_apps_strict: strictRunning,
        running_call_apps_soft: softRunning,
        browser_url: state.browserUrl,
        browser_url_matches: browserUrlMatches,
      },
    };
  }

  return {
    confidence: "MEDIUM",
    reason: "mic in use, no call evidence (likely dictation)",
    evidence: {
      mic_in_use: true,
      frontmost_bundle_id: state.frontmostBundleId,
      running_call_apps_strict: strictRunning,
      running_call_apps_soft: softRunning,
      browser_url: state.browserUrl,
      browser_url_matches: browserUrlMatches,
    },
  };
}

/**
 * Effective `mic_in_use` after subtracting our own bundle ids from
 * the owners list. Three branches:
 *   1. `rawInUse` is false → effective is false.
 *   2. `micOwners` is undefined or empty → degraded mode: trust the
 *      raw bit alone. This covers macOS < 14.4 (where the helper
 *      returns []) and any pre-v0.9.8 fixture that doesn't carry
 *      owners.
 *   3. `micOwners` is non-empty → external owners drive the answer.
 *      `[ai.swrag.helper]` → false (only us). `[us.zoom.xos]` →
 *      true. `[us.zoom.xos, ai.swrag.helper]` → true.
 *
 * Exported for tests + ad-hoc diagnostics. `computeSignal` is the
 * one production caller.
 */
export function computeEffectiveMicInUse(
  rawInUse: boolean,
  micOwners: readonly string[] | undefined,
): boolean {
  if (!rawInUse) return false;
  if (micOwners == null || micOwners.length === 0) return true;
  for (const owner of micOwners) {
    if (!SWRAG_OWNER_BUNDLE_IDS.has(owner)) return true;
  }
  return false;
}

function toArray(s: ReadonlySet<string> | string[]): string[] {
  return Array.isArray(s) ? [...s] : [...s.values()];
}

/**
 * The detector. One instance per consumer (CLI status command, daemon).
 *
 * Lifecycle:
 *   const det = new MeetingDetector({ onEdge: ... });
 *   for await (const ev of helper.events) await det.handleEvent(ev);
 *   const signal = det.signal();
 */
export class MeetingDetector {
  private state: InternalState = {
    frontmostBundleId: null,
    frontmostName: null,
    micInUse: false,
    micOwners: [],
    runningCallAppsStrict: new Set(),
    runningCallAppsSoft: new Set(),
    browserUrl: null,
  };
  private lastCommitted: MeetingConfidence = "NONE";
  private pendingEdge: {
    target: MeetingConfidence;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /**
   * One-shot guard for the "degraded mode" warning. We log it once
   * per detector lifetime the first time we see `mic_in_use=true`
   * without any owners — that's diagnostic for "running on macOS <
   * 14.4 or our CoreAudio query is failing, the recorder-mask fix
   * isn't available, fall back to raw mic_in_use".
   */
  private degradedModeWarned = false;
  private readonly debounceMs: number;
  private readonly resolveBrowserUrl: (bundleId: string) => Promise<string | null>;
  private readonly onEdge: ((edge: MeetingEdge) => void) | undefined;

  constructor(opts: DetectorOptions = {}) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.resolveBrowserUrl = opts.resolveBrowserUrl ?? ((bid) => getBrowserUrl(bid));
    this.onEdge = opts.onEdge;
  }

  /** Compute the current signal from accumulated state. Pure. */
  signal(): MeetingSignal {
    return computeSignal({
      frontmostBundleId: this.state.frontmostBundleId,
      micInUse: this.state.micInUse,
      micOwners: this.state.micOwners,
      runningCallAppsStrict: this.state.runningCallAppsStrict,
      runningCallAppsSoft: this.state.runningCallAppsSoft,
      browserUrl: this.state.browserUrl,
    });
  }

  /**
   * Apply one event from the helper's stream. May trigger an async
   * browser URL query — the returned promise resolves once the new
   * signal has been computed (the debounce timer is independent and
   * fires later in the background).
   */
  async handleEvent(ev: EventLine): Promise<MeetingSignal> {
    this.applyEvent(ev);
    await this.maybeRefreshBrowserUrl();
    const current = this.signal();
    this.scheduleEdgeIfChanged(current);
    return current;
  }

  /**
   * Synchronous variant for tests that don't want to wait on browser
   * URL resolution. Skips the URL refresh; otherwise identical.
   */
  handleEventSync(ev: EventLine): MeetingSignal {
    this.applyEvent(ev);
    const current = this.signal();
    this.scheduleEdgeIfChanged(current);
    return current;
  }

  /** Cancel any pending debounced edge. Safe to call at shutdown. */
  dispose(): void {
    if (this.pendingEdge) {
      clearTimeout(this.pendingEdge.timer);
      this.pendingEdge = null;
    }
  }

  /**
   * Read-only view of internal state. Useful for the `swrag meeting
   * status` CLI which wants to print the full evidence picture.
   */
  snapshot(): Readonly<InternalState> {
    return {
      frontmostBundleId: this.state.frontmostBundleId,
      frontmostName: this.state.frontmostName,
      micInUse: this.state.micInUse,
      micOwners: [...this.state.micOwners],
      runningCallAppsStrict: new Set(this.state.runningCallAppsStrict),
      runningCallAppsSoft: new Set(this.state.runningCallAppsSoft),
      browserUrl: this.state.browserUrl,
    };
  }

  /* ------------------------ private ------------------------ */

  private applyEvent(ev: EventLine): void {
    switch (ev.event) {
      case "snapshot":
        this.state.frontmostBundleId = ev.frontmost.bundleId;
        this.state.frontmostName = ev.frontmost.name;
        this.state.micInUse = ev.mic.in_use;
        this.state.micOwners = [...ev.mic.owners];
        this.state.runningCallAppsStrict = new Set(ev.running_call_apps.strict);
        this.state.runningCallAppsSoft = new Set(ev.running_call_apps.soft);
        // Browser URL doesn't survive across snapshot — old context is
        // stale. Forced re-query on the next applicable event.
        this.state.browserUrl = null;
        break;
      case "frontmost_changed":
        this.state.frontmostBundleId = ev.bundle_id;
        this.state.frontmostName = ev.name;
        // Frontmost change invalidates any cached browser URL.
        this.state.browserUrl = null;
        break;
      case "app_launched": {
        const bid = ev.bundle_id;
        if (bid != null) {
          if (STRICT_CALL_APPS.has(bid)) this.state.runningCallAppsStrict.add(bid);
          if (SOFT_CALL_APPS.has(bid)) this.state.runningCallAppsSoft.add(bid);
        }
        break;
      }
      case "app_terminated": {
        const bid = ev.bundle_id;
        if (bid != null) {
          this.state.runningCallAppsStrict.delete(bid);
          this.state.runningCallAppsSoft.delete(bid);
        }
        break;
      }
      case "mic_changed":
        this.state.micInUse = ev.in_use;
        this.state.micOwners = [...ev.owners];
        break;
    }
    this.maybeWarnDegradedMode();
  }

  /**
   * Log a one-shot warning the first time we observe `mic_in_use=true`
   * without any owners. On macOS 14.4+ with a healthy CoreAudio query
   * this should never happen — the moment any process opens the mic,
   * the helper resolves at least one bundle id. An empty list at
   * `in_use=true` means we're in degraded mode (older OS or a query
   * failure) and the recorder-PID-mask fix is unavailable. The
   * detector still works in this branch, but the HIGH → NONE
   * transition relies entirely on the meeting app voluntarily
   * releasing the mic before our recorder does — same as v0.9.7
   * behaviour.
   */
  private maybeWarnDegradedMode(): void {
    if (this.degradedModeWarned) return;
    if (!this.state.micInUse) return;
    if (this.state.micOwners.length > 0) return;
    this.degradedModeWarned = true;
    warn(
      "detect: mic in use with empty owners list — degraded mode " +
        "(macOS < 14.4 or CoreAudio query failed); recorder PID mask " +
        "unavailable, falling back to raw mic_in_use",
    );
  }

  /**
   * Query the browser URL iff the new state shape benefits from URL
   * evidence:
   *   - mic in use AND
   *   - frontmost is a known browser AND
   *   - we don't already have HIGH evidence from a running strict
   *     call app (no need to corroborate).
   *
   * The check is intentionally based on POST-event state — applying
   * the event may have made URL evidence newly relevant (e.g.
   * mic_changed → in_use=true while a browser is already frontmost).
   */
  private async maybeRefreshBrowserUrl(): Promise<void> {
    const fb = this.state.frontmostBundleId;
    if (!this.state.micInUse) return;
    if (fb == null || !isKnownBrowser(fb)) return;
    if (this.state.runningCallAppsStrict.size > 0) {
      // Already HIGH via strict-running; URL is corroborative noise.
      return;
    }
    try {
      const url = await this.resolveBrowserUrl(fb);
      this.state.browserUrl = url;
    } catch (e) {
      verbose(`detect: browser URL query failed: ${e instanceof Error ? e.message : String(e)}`);
      this.state.browserUrl = null;
    }
  }

  /**
   * If `current.confidence` differs from the last committed level,
   * schedule a commit in `debounceMs`. If a later event flips the
   * confidence back before the timer fires, cancel the pending edge.
   *
   * Only NONE↔HIGH and MEDIUM transitions go through debounce —
   * intermediate MEDIUM during a flicker counts as a flip back, so
   * the timer is reset / cancelled.
   */
  private scheduleEdgeIfChanged(current: MeetingSignal): void {
    if (current.confidence === this.lastCommitted) {
      // Same as committed — cancel any pending edge (a flip-back
      // happened during the debounce window).
      if (this.pendingEdge) {
        clearTimeout(this.pendingEdge.timer);
        this.pendingEdge = null;
      }
      return;
    }
    if (this.pendingEdge?.target === current.confidence) {
      // Already pending the same edge — don't restart the timer; let
      // the original land. (Restarting would unintentionally extend
      // the wait by every redundant event during the window.)
      return;
    }
    // Different target than what's pending (e.g. NONE→HIGH then HIGH→MEDIUM)
    // or no pending. Cancel and start a fresh one.
    if (this.pendingEdge) {
      clearTimeout(this.pendingEdge.timer);
      this.pendingEdge = null;
    }
    const target = current.confidence;
    const from = this.lastCommitted;
    const timer = setTimeout(() => {
      // On fire, re-read the current signal (state may have shifted
      // during the window). Commit only if the target is still the
      // latest signal — otherwise the window's been invalidated.
      const fresh = this.signal();
      if (fresh.confidence !== target) {
        this.pendingEdge = null;
        // Don't re-schedule here; the next event will trigger its
        // own scheduling pass. (Avoids reentrant timer storms.)
        return;
      }
      this.lastCommitted = target;
      this.pendingEdge = null;
      this.onEdge?.({ from, to: target, signal: fresh });
    }, this.debounceMs);
    // Allow the process to exit even if a debounce timer is pending
    // — the helper subprocess is what holds the process open, not us.
    if (typeof timer === "object" && "unref" in timer) {
      try {
        (timer as { unref?: () => void }).unref?.();
      } catch {
        // best-effort
      }
    }
    this.pendingEdge = { target, timer };
  }
}
