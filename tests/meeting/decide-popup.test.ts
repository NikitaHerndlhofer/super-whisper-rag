/**
 * Tests for the pure popup-decision function (v0.8.0).
 *
 * The function is the heart of the configurable trigger system, so
 * coverage is deliberately exhaustive:
 *   - Every threshold × confidence combination.
 *   - Allowlist forcing fire by bundle and by URL match.
 *   - Blocklist suppressing by bundle and by URL match.
 *   - Schedule windows: in/out, day-of-week boundaries, midnight
 *     wrap, disabled schedule = no gating.
 *   - Precedence: allowlist > schedule > blocklist > threshold.
 *
 * Everything is pure-functional — no DB, no async, no fixtures.
 */
import { describe, expect, test } from "bun:test";
import { defaultConfig, type PopupConfig } from "../../src/meeting/config.ts";
import { decidePopup, isNowInsideAnyWindow } from "../../src/meeting/decide-popup.ts";
import type { MeetingConfidence, MeetingSignal } from "../../src/meeting/detect.ts";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeSignal(opts: {
  confidence: MeetingConfidence;
  bundleId?: string | null;
  url?: string | null;
  reason?: string;
}): MeetingSignal {
  return {
    confidence: opts.confidence,
    reason: opts.reason ?? "test",
    evidence: {
      mic_in_use: opts.confidence !== "NONE",
      frontmost_bundle_id: opts.bundleId ?? null,
      running_call_apps_strict: [],
      running_call_apps_soft: [],
      browser_url: opts.url ?? null,
      browser_url_matches: false,
    },
  };
}

/** Build a fresh config with the supplied overrides applied. */
function cfg(mutate: (c: PopupConfig) => void = () => {}): PopupConfig {
  const c = defaultConfig();
  mutate(c);
  return c;
}

/* -------------------------------------------------------------------------- */
/* Threshold matrix                                                           */
/* -------------------------------------------------------------------------- */

describe("threshold gating", () => {
  test("NONE confidence never fires (gate happens before any other check)", () => {
    const c = cfg();
    const d = decidePopup(makeSignal({ confidence: "NONE" }), c, new Date("2026-05-22T12:00:00Z"));
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("no signal");
  });

  test("threshold=HIGH + signal=HIGH → fire", () => {
    const c = cfg();
    const d = decidePopup(makeSignal({ confidence: "HIGH" }), c, new Date());
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("threshold=HIGH, signal=HIGH");
  });

  test("threshold=HIGH + signal=MEDIUM → suppress (this is the v0.7.0-equivalent default)", () => {
    const c = cfg();
    const d = decidePopup(makeSignal({ confidence: "MEDIUM" }), c, new Date());
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("threshold=HIGH but signal=MEDIUM");
  });

  test("threshold=MEDIUM + signal=HIGH → fire", () => {
    const c = cfg((x) => {
      x.threshold = "MEDIUM";
    });
    const d = decidePopup(makeSignal({ confidence: "HIGH" }), c, new Date());
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("threshold=MEDIUM, signal=HIGH");
  });

  test("threshold=MEDIUM + signal=MEDIUM → fire (this is the more-aggressive opt-in)", () => {
    const c = cfg((x) => {
      x.threshold = "MEDIUM";
    });
    const d = decidePopup(makeSignal({ confidence: "MEDIUM" }), c, new Date());
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("threshold=MEDIUM, signal=MEDIUM");
  });

  test("threshold=NEVER suppresses every confidence (other than NONE which never fires anyway)", () => {
    const c = cfg((x) => {
      x.threshold = "NEVER";
    });
    for (const conf of ["HIGH", "MEDIUM"] as const) {
      const d = decidePopup(makeSignal({ confidence: conf }), c, new Date());
      expect(d.fire).toBe(false);
      expect(d.reason).toBe("threshold=NEVER");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Allowlist                                                                  */
/* -------------------------------------------------------------------------- */

describe("allowlist forces fire", () => {
  test("bundle_id match forces fire even with threshold=NEVER", () => {
    const c = cfg((x) => {
      x.threshold = "NEVER";
      x.allowlist.bundle_ids.push("us.zoom.xos");
    });
    const d = decidePopup(
      makeSignal({ confidence: "MEDIUM", bundleId: "us.zoom.xos" }),
      c,
      new Date(),
    );
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("allowlist match");
    expect(d.reason).toContain("us.zoom.xos");
  });

  test("URL regex match forces fire even with blocklist also matching", () => {
    const c = cfg((x) => {
      x.allowlist.url_patterns.push("^https://meet\\.google\\.com/");
      // Bundle blocked, but URL is on the allowlist — allow wins.
      x.blocklist.bundle_ids.push("com.google.Chrome");
    });
    const d = decidePopup(
      makeSignal({
        confidence: "HIGH",
        bundleId: "com.google.Chrome",
        url: "https://meet.google.com/abc-defg-hij",
      }),
      c,
      new Date(),
    );
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("allowlist match");
    expect(d.reason).toContain("https://meet");
  });

  test("allowlist with confidence=NONE still does NOT fire (NONE is the absolute gate)", () => {
    const c = cfg((x) => {
      x.allowlist.bundle_ids.push("us.zoom.xos");
    });
    const d = decidePopup(
      makeSignal({ confidence: "NONE", bundleId: "us.zoom.xos" }),
      c,
      new Date(),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("no signal");
  });
});

/* -------------------------------------------------------------------------- */
/* Blocklist                                                                  */
/* -------------------------------------------------------------------------- */

describe("blocklist suppresses", () => {
  test("bundle_id match suppresses HIGH-confidence signal", () => {
    const c = cfg((x) => {
      x.blocklist.bundle_ids.push("us.zoom.xos");
    });
    const d = decidePopup(
      makeSignal({ confidence: "HIGH", bundleId: "us.zoom.xos" }),
      c,
      new Date(),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("blocklist match");
    expect(d.reason).toContain("us.zoom.xos");
  });

  test("URL regex match suppresses", () => {
    const c = cfg((x) => {
      x.blocklist.url_patterns.push("zoom\\.us/j/12345");
    });
    const d = decidePopup(
      makeSignal({
        confidence: "HIGH",
        bundleId: "com.google.Chrome",
        url: "https://example.zoom.us/j/12345",
      }),
      c,
      new Date(),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("blocklist match");
  });

  test("blocklist with no match falls through to threshold gating", () => {
    const c = cfg((x) => {
      x.blocklist.bundle_ids.push("us.zoom.xos");
    });
    const d = decidePopup(
      makeSignal({ confidence: "HIGH", bundleId: "com.google.Chrome" }),
      c,
      new Date(),
    );
    expect(d.fire).toBe(true);
  });

  test("blocklist with malformed regex doesn't crash (defense in depth — write-time validation should normally catch this)", () => {
    // Bypass writeConfig's validation by manually setting a bogus
    // regex string. The decision function must not throw on it.
    const c = cfg((x) => {
      x.blocklist.url_patterns.push("(unclosed");
    });
    const d = decidePopup(
      makeSignal({
        confidence: "HIGH",
        bundleId: "com.google.Chrome",
        url: "https://meet.google.com/abc-defg-hij",
      }),
      c,
      new Date(),
    );
    // Bad pattern → treated as a non-match; the signal falls through
    // to the threshold gate and fires.
    expect(d.fire).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Schedule                                                                   */
/* -------------------------------------------------------------------------- */

describe("schedule windows", () => {
  test("schedule.enabled=false leaves the popup ungated (the default)", () => {
    const c = cfg();
    // Default schedule is disabled; a HIGH signal should fire regardless
    // of `now`.
    expect(c.schedule.enabled).toBe(false);
    const d = decidePopup(makeSignal({ confidence: "HIGH" }), c, new Date("2026-05-22T03:00:00Z"));
    expect(d.fire).toBe(true);
  });

  test("inside a single weekday window → fire", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["fri"], start: "09:00", end: "17:00" });
    });
    // 2026-05-22 is a Friday. 12:00 UTC is inside 09:00-17:00.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-22T12:00:00Z"),
    );
    expect(d.fire).toBe(true);
  });

  test("outside a single weekday window → suppress with reason=outside schedule", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["fri"], start: "09:00", end: "17:00" });
    });
    // Friday 03:00 UTC is before the window.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-22T03:00:00Z"),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("outside schedule");
  });

  test("wrong day of week → suppress (Saturday gets no window when only weekdays are configured)", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" });
    });
    // 2026-05-23 is Saturday — 12:00 UTC.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-23T12:00:00Z"),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("outside schedule");
  });

  test("multiple windows: union semantics — match any one fires", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "09:00", end: "12:00" });
      x.schedule.windows.push({ days: ["mon"], start: "14:00", end: "17:00" });
    });
    // 2026-05-25 is Monday. Test the gap between windows.
    const midGap = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-25T13:00:00Z"),
    );
    expect(midGap.fire).toBe(false);
    const inSecond = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-25T15:00:00Z"),
    );
    expect(inSecond.fire).toBe(true);
  });

  test("midnight-crossing window (22:00-02:00 mon): in-tail next day → fire", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "22:00", end: "02:00" });
    });
    // 2026-05-26 is Tuesday. 01:00 UTC is in the tail of the Monday
    // 22:00 → Tuesday 02:00 window.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-26T01:00:00Z"),
    );
    expect(d.fire).toBe(true);
  });

  test("midnight-crossing window: start side fires", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "22:00", end: "02:00" });
    });
    // 2026-05-25 is Monday. 23:00 UTC is in the start side.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-25T23:00:00Z"),
    );
    expect(d.fire).toBe(true);
  });

  test("midnight-crossing window: outside on the tail-day's afternoon → suppress", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "22:00", end: "02:00" });
    });
    // Tuesday 14:00 UTC — way past the 02:00 tail end.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-26T14:00:00Z"),
    );
    expect(d.fire).toBe(false);
  });

  test("midnight-crossing window: outside on the Sunday before → suppress", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "22:00", end: "02:00" });
    });
    // Sunday 23:00 UTC — the wrap window starts on Monday at 22:00,
    // so Sunday 23:00 isn't in any window.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-24T23:00:00Z"),
    );
    expect(d.fire).toBe(false);
  });

  test("isNowInsideAnyWindow with zero windows always returns false (caller never reaches here unless schedule is enabled)", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      // No windows added.
    });
    const inside = isNowInsideAnyWindow(new Date("2026-05-22T12:00:00Z"), c.schedule);
    expect(inside).toBe(false);
  });

  test("explicit timezone: window expressed in America/New_York gates a UTC `now` correctly", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "America/New_York";
      x.schedule.windows.push({ days: ["mon"], start: "09:00", end: "17:00" });
    });
    // 2026-05-25 is Monday. 13:00 UTC = 09:00 ET (DST). Inside.
    const inside = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-25T13:00:00Z"),
    );
    expect(inside.fire).toBe(true);
    // 2026-05-25 12:00 UTC = 08:00 ET — outside the 09-17 window.
    const before = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-25T12:00:00Z"),
    );
    expect(before.fire).toBe(false);
  });

  test("invalid timezone string falls back to local time without throwing", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "Mars/Olympus_Mons";
      // 24h window so the test is independent of the host's local time.
      x.schedule.windows.push({
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "00:01",
        end: "23:59",
      });
    });
    // Any time inside the broad window should still report inside;
    // function must not throw on the bad tz.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-22T12:00:00Z"),
    );
    expect(d.fire).toBe(true);
  });

  test("empty start==end window is skipped, not treated as 24h", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "09:00", end: "09:00" });
    });
    // Monday 12:00 UTC should still suppress because the single
    // window is empty (start == end).
    const d = decidePopup(
      makeSignal({ confidence: "HIGH" }),
      c,
      new Date("2026-05-25T12:00:00Z"),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("outside schedule");
  });
});

/* -------------------------------------------------------------------------- */
/* Precedence — the most-tested interactions                                  */
/* -------------------------------------------------------------------------- */

describe("gate precedence: allowlist > schedule > blocklist > threshold", () => {
  test("allowlist match beats schedule (out-of-window + allowlist → fire)", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "09:00", end: "17:00" });
      x.allowlist.bundle_ids.push("us.zoom.xos");
    });
    // Saturday — far out of window — but bundle is on the allowlist.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH", bundleId: "us.zoom.xos" }),
      c,
      new Date("2026-05-23T12:00:00Z"),
    );
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("allowlist match");
  });

  test("schedule beats blocklist (out-of-window with blocklist match → still suppressed for schedule reason)", () => {
    const c = cfg((x) => {
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon"], start: "09:00", end: "17:00" });
      x.blocklist.bundle_ids.push("us.zoom.xos");
    });
    // Out of window AND blocklisted — schedule check runs first.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH", bundleId: "us.zoom.xos" }),
      c,
      new Date("2026-05-23T12:00:00Z"),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("outside schedule");
  });

  test("blocklist beats threshold (in-window + blocklist match + threshold=MEDIUM → suppress)", () => {
    const c = cfg((x) => {
      x.threshold = "MEDIUM";
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "23:59" });
      x.blocklist.bundle_ids.push("us.zoom.xos");
    });
    const d = decidePopup(
      makeSignal({ confidence: "HIGH", bundleId: "us.zoom.xos" }),
      c,
      new Date("2026-05-22T12:00:00Z"),
    );
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("blocklist match");
  });

  test("fully-configured happy path: in-window + no blocklist + threshold passes → fire", () => {
    const c = cfg((x) => {
      x.threshold = "HIGH";
      x.schedule.enabled = true;
      x.schedule.timezone = "UTC";
      x.schedule.windows.push({ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00" });
    });
    // 2026-05-22 is Friday, 14:00 UTC — inside the weekday work window.
    const d = decidePopup(
      makeSignal({ confidence: "HIGH", bundleId: "us.zoom.xos" }),
      c,
      new Date("2026-05-22T14:00:00Z"),
    );
    expect(d.fire).toBe(true);
  });
});
