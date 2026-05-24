/**
 * Pure decision function for the meeting popup.
 *
 * Given a debounce-committed `MeetingSignal` from the detector and
 * the user's `PopupConfig`, decide whether to fire the popup and
 * return a human-readable reason. The function is intentionally
 * pure: no I/O, no clock reads (the `now` value is injected so
 * tests can pin the wall clock), and every input is a plain value.
 *
 * Order of checks (each gate may short-circuit):
 *
 *   1. NONE confidence → never fire (no signal).
 *   2. **Allowlist** — matches force-fire regardless of threshold,
 *      schedule, or blocklist. The use-case is "I just enabled
 *      strict gating, but please always nag me when I open
 *      meet.google.com — I forget to record otherwise."
 *   3. **Schedule** — if `schedule.enabled` and `now` falls
 *      outside every window, suppress. Day-of-week and
 *      hour-of-day are derived against `schedule.timezone`
 *      ("local" = system tz). Windows where `start > end` wrap
 *      past midnight; the day code on a wrapping window is the
 *      *start* day.
 *   4. **Blocklist** — matches suppress the popup. Useful for
 *      "I have a recurring Zoom standup with my therapist; never
 *      record that one."
 *   5. **Threshold** — confidence floor for firing.
 *        - NEVER: never fire.
 *        - HIGH: fire only on HIGH-confidence signals.
 *        - MEDIUM: fire on HIGH or MEDIUM (NONE was filtered
 *          earlier).
 *
 * Returns `{ fire, reason }` so the daemon log line and the
 * decide-popup tests both see WHY a popup did or didn't fire.
 */
import type { PopupConfig, Schedule, MatchList } from "./config.ts";
import type { MeetingSignal } from "./detect.ts";

export interface PopupDecision {
  fire: boolean;
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function decidePopup(
  signal: MeetingSignal,
  config: PopupConfig,
  now: Date,
): PopupDecision {
  if (signal.confidence === "NONE") {
    return { fire: false, reason: "no signal" };
  }

  // Allowlist runs FIRST and forces a fire — see the docstring's
  // rationale. We surface the matching predicate so the log line
  // reveals which entry won.
  const allowMatch = matchListAgainstSignal(config.allowlist, signal);
  if (allowMatch) {
    return { fire: true, reason: `allowlist match: ${allowMatch}` };
  }

  if (config.schedule.enabled) {
    const inside = isNowInsideAnyWindow(now, config.schedule);
    if (!inside) {
      return { fire: false, reason: "outside schedule" };
    }
  }

  const blockMatch = matchListAgainstSignal(config.blocklist, signal);
  if (blockMatch) {
    return { fire: false, reason: `blocklist match: ${blockMatch}` };
  }

  // Threshold gating. NONE was already handled.
  switch (config.threshold) {
    case "NEVER":
      return { fire: false, reason: "threshold=NEVER" };
    case "HIGH":
      if (signal.confidence !== "HIGH") {
        return { fire: false, reason: `threshold=HIGH but signal=${signal.confidence}` };
      }
      return { fire: true, reason: "threshold=HIGH, signal=HIGH" };
    case "MEDIUM":
      // MEDIUM threshold accepts both MEDIUM and HIGH signals.
      return { fire: true, reason: `threshold=MEDIUM, signal=${signal.confidence}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Match-list helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Return a human-readable description of the first matching entry
 * (`bundle_id:<x>` or `url:<regex>`) or null if nothing matches.
 * Used by both allow and block lists with the same predicate
 * semantics — only the action diverges in `decidePopup`.
 */
function matchListAgainstSignal(list: MatchList, signal: MeetingSignal): string | null {
  const bundle = signal.evidence.frontmost_bundle_id;
  if (bundle != null) {
    for (const allowed of list.bundle_ids) {
      if (allowed === bundle) return `bundle_id=${bundle}`;
    }
  }
  const url = signal.evidence.browser_url;
  if (url != null && url.length > 0) {
    for (const pattern of list.url_patterns) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        // Malformed regex was supposed to be rejected at write
        // time; if we ever see one here just treat it as a non-match
        // rather than throwing — defense in depth.
        continue;
      }
      if (re.test(url)) return `url~${pattern}`;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Schedule helpers                                                           */
/* -------------------------------------------------------------------------- */

const DAY_INDEX: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DAY_CODE_BY_INDEX = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Compute `{ dayCode, minutes }` for `now` in the given timezone.
 * "local" means the system tz (no Intl override). The function is
 * tz-aware via `Intl.DateTimeFormat`'s `weekday` and 24-hour parts;
 * the `Date.prototype.get*` family would silently fall back to
 * local-time and silently drift if the user's box is in a
 * different tz than the schedule's.
 */
function localiseNow(now: Date, timezone: string): {
  dayIdx: number;
  minutes: number;
} {
  const useTz = timezone !== "local";
  if (!useTz) {
    return {
      dayIdx: now.getDay(),
      minutes: now.getHours() * 60 + now.getMinutes(),
    };
  }
  // The two formatters share a tz option; we split weekday + numeric
  // hour/minute because Intl gives them in separate parts.
  let dayCode: string;
  let hour = 0;
  let minute = 0;
  try {
    const weekdayFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    });
    const wd = weekdayFmt.format(now).toLowerCase().slice(0, 3);
    dayCode = wd;
    const timeFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = timeFmt.formatToParts(now);
    for (const p of parts) {
      if (p.type === "hour") hour = Number.parseInt(p.value, 10);
      else if (p.type === "minute") minute = Number.parseInt(p.value, 10);
    }
  } catch {
    // Bad tz — fall back to local time. The CLI write surface
    // tries to validate first, so this should be rare.
    return {
      dayIdx: now.getDay(),
      minutes: now.getHours() * 60 + now.getMinutes(),
    };
  }
  // Intl's "24" hour value covers the edge where formatting rounds
  // up to 24:00; collapse to 00:00 of the same day for our minute
  // arithmetic.
  if (hour === 24) hour = 0;
  return {
    dayIdx: DAY_INDEX[dayCode] ?? now.getDay(),
    minutes: hour * 60 + minute,
  };
}

function parseHHMM(s: string): number {
  // Schema already validated the shape — this is a guarded
  // safe-parse for defense in depth.
  const [h, m] = s.split(":");
  return (Number.parseInt(h ?? "0", 10) % 24) * 60 + (Number.parseInt(m ?? "0", 10) % 60);
}

/**
 * True iff `now` lies inside at least one of `schedule.windows`,
 * day-of-week derived from `schedule.timezone`. A schedule with
 * zero windows always reports "outside" — there's nothing to be
 * inside of. The caller (decide-popup) only consults this when
 * `schedule.enabled === true`.
 */
export function isNowInsideAnyWindow(now: Date, schedule: Schedule): boolean {
  if (schedule.windows.length === 0) return false;
  const here = localiseNow(now, schedule.timezone);
  for (const w of schedule.windows) {
    const start = parseHHMM(w.start);
    const end = parseHHMM(w.end);
    if (start === end) {
      // Empty window — skip rather than treat as 24h to avoid
      // surprising users who typed `09:00-09:00` expecting "no
      // window".
      continue;
    }
    // Map each `day` code into the day index it represents. For
    // a wrapping window (start > end), the day code names the
    // start day; we check both "today + still ramp" and
    // "yesterday + still in the wrap tail".
    for (const dayCode of w.days) {
      const dayIdx = DAY_INDEX[dayCode];
      if (dayIdx == null) continue;
      if (start < end) {
        if (here.dayIdx === dayIdx && here.minutes >= start && here.minutes < end) {
          return true;
        }
      } else {
        // start > end — wrapping window.
        const yesterdayIdx = (dayIdx + 1) % 7; // dayCode is start day; the wrap-tail lands on the *next* day index.
        if (here.dayIdx === dayIdx && here.minutes >= start) {
          return true;
        }
        if (here.dayIdx === yesterdayIdx && here.minutes < end) {
          return true;
        }
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Test-only export (kept for completeness, not in the index)                 */
/* -------------------------------------------------------------------------- */

export const __test = {
  DAY_INDEX,
  DAY_CODE_BY_INDEX,
  parseHHMM,
  localiseNow,
};
