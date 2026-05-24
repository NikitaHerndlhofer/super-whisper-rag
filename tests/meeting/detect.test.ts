/**
 * Detector tests — scripted event streams in, asserted MeetingSignal out.
 *
 * Covers the Phase 2 spec for `src/meeting/detect.ts`:
 *
 *   - Confidence rules: HIGH / MEDIUM / NONE per the plan.
 *   - STRICT vs SOFT call-app split: Slack frontmost AND mic = HIGH;
 *     Slack merely running (not frontmost) = MEDIUM (no popup).
 *   - Browser URL patterns are path-required: landing on the meeting
 *     service's homepage stays NOT HIGH; a real room URL bumps to HIGH.
 *   - Debounce: an edge that flickers back inside the 1.5 s window does
 *     NOT commit; a stable edge past the window does.
 *   - Browser URL resolver is invoked only when the new state benefits
 *     from URL evidence (mic in use AND frontmost is a browser AND we
 *     don't already have HIGH from a strict running call app).
 */
import { describe, expect, test } from "bun:test";
import type { EventLine } from "../../src/mac/helper.ts";
import {
  BROWSERS,
  MeetingDetector,
  MEETING_URL_PATTERNS,
  type MeetingEdge,
  computeSignal,
} from "../../src/meeting/detect.ts";

/* -------------------------------------------------------------------------- */
/* Event builders                                                             */
/* -------------------------------------------------------------------------- */

function snapshot(opts: {
  bundleId?: string | null;
  micInUse?: boolean;
  strict?: string[];
  soft?: string[];
}): EventLine {
  return {
    event: "snapshot",
    frontmost: {
      bundleId: opts.bundleId ?? null,
      name: null,
      pid: null,
    },
    mic: {
      in_use: opts.micInUse ?? false,
      owners: [],
    },
    running_call_apps: {
      strict: opts.strict ?? [],
      soft: opts.soft ?? [],
    },
  };
}

function frontmost(bundleId: string | null): EventLine {
  return { event: "frontmost_changed", bundle_id: bundleId, name: null, pid: null };
}

function micChanged(inUse: boolean): EventLine {
  return { event: "mic_changed", in_use: inUse, owners: [] };
}

function launched(bundleId: string): EventLine {
  return { event: "app_launched", bundle_id: bundleId, name: null, pid: 1 };
}

function terminated(bundleId: string): EventLine {
  return { event: "app_terminated", bundle_id: bundleId, name: null, pid: 1 };
}

/* -------------------------------------------------------------------------- */
/* MEETING_URL_PATTERNS specificity                                           */
/* -------------------------------------------------------------------------- */

describe("MEETING_URL_PATTERNS", () => {
  test("matches real Google Meet room URLs", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(matches("https://meet.google.com/abc-defg-hij?authuser=0")).toBe(true);
  });

  test("does NOT match Google Meet's marketing pages", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://meet.google.com/")).toBe(false);
    expect(matches("https://meet.google.com/about")).toBe(false);
    expect(matches("https://meet.google.com/new")).toBe(false);
  });

  test("matches Teams meetup-join links (microsoft.com and live.com)", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://teams.microsoft.com/l/meetup-join/abc")).toBe(true);
    expect(matches("https://teams.live.com/l/meetup-join/xyz")).toBe(true);
    expect(matches("https://teams.microsoft.com/_#/conversations/general/meetup-join")).toBe(true);
  });

  test("does NOT match Teams home / file links", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://teams.microsoft.com/")).toBe(false);
    expect(matches("https://teams.microsoft.com/_#/conversations/general")).toBe(false);
  });

  test("matches Zoom j/<digits> and wc/<digits> (with optional subdomain)", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://zoom.us/j/123456789")).toBe(true);
    expect(matches("https://us02web.zoom.us/j/987654321")).toBe(true);
    expect(matches("https://zoom.us/wc/123456789/join")).toBe(true);
  });

  test("does NOT match zoom.us marketing pages", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://zoom.us/")).toBe(false);
    expect(matches("https://zoom.us/pricing")).toBe(false);
    expect(matches("https://zoom.us/download")).toBe(false);
  });

  test("matches Whereby rooms but not the homepage", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://whereby.com/my-room")).toBe(true);
    expect(matches("https://whereby.com/")).toBe(false);
  });

  test("matches Slack huddle URLs but not regular channel views", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(
      matches("https://app.slack.com/client/T01234567/C7654321?huddle=H1234"),
    ).toBe(true);
    expect(matches("https://app.slack.com/client/T01234567/C7654321")).toBe(false);
  });

  test("matches Discord channel URLs", () => {
    const matches = (u: string) => MEETING_URL_PATTERNS.some((re) => re.test(u));
    expect(matches("https://discord.com/channels/1234/5678")).toBe(true);
    expect(matches("https://discord.com/")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Confidence rules (computeSignal directly)                                  */
/* -------------------------------------------------------------------------- */

describe("computeSignal — confidence rules", () => {
  test("NONE: mic not in use, regardless of running apps / frontmost", () => {
    expect(
      computeSignal({
        frontmostBundleId: "us.zoom.xos",
        micInUse: false,
        runningCallAppsStrict: ["us.zoom.xos"],
        runningCallAppsSoft: [],
        browserUrl: "https://meet.google.com/abc-defg-hij",
      }).confidence,
    ).toBe("NONE");
  });

  test("MEDIUM: mic in use alone — no call evidence", () => {
    const sig = computeSignal({
      frontmostBundleId: "com.apple.Notes",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: [],
      browserUrl: null,
    });
    expect(sig.confidence).toBe("MEDIUM");
    expect(sig.reason).toMatch(/dictation/i);
  });

  test("HIGH: mic + frontmost is a STRICT call app (Zoom)", () => {
    const sig = computeSignal({
      frontmostBundleId: "us.zoom.xos",
      micInUse: true,
      runningCallAppsStrict: ["us.zoom.xos"],
      runningCallAppsSoft: [],
      browserUrl: null,
    });
    expect(sig.confidence).toBe("HIGH");
  });

  test("HIGH: mic + frontmost is a SOFT call app (Slack frontmost)", () => {
    const sig = computeSignal({
      frontmostBundleId: "com.tinyspeck.slackmacgap",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: ["com.tinyspeck.slackmacgap"],
      browserUrl: null,
    });
    expect(sig.confidence).toBe("HIGH");
  });

  test("MEDIUM: SOFT call app running but NOT frontmost (the canonical Slack false-positive)", () => {
    // Slack is always running. Without the strict/soft split this would
    // false-positive on every "user is just dictating into Notes while
    // Slack runs in the background" workflow.
    const sig = computeSignal({
      frontmostBundleId: "com.apple.Notes",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: ["com.tinyspeck.slackmacgap"],
      browserUrl: null,
    });
    expect(sig.confidence).toBe("MEDIUM");
  });

  test("HIGH: mic + STRICT call app running in background (Zoom not frontmost)", () => {
    const sig = computeSignal({
      frontmostBundleId: "com.apple.Notes",
      micInUse: true,
      runningCallAppsStrict: ["us.zoom.xos"],
      runningCallAppsSoft: [],
      browserUrl: null,
    });
    expect(sig.confidence).toBe("HIGH");
  });

  test("HIGH: mic + browser frontmost on a real meeting URL", () => {
    const sig = computeSignal({
      frontmostBundleId: "com.google.Chrome",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: [],
      browserUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(sig.confidence).toBe("HIGH");
  });

  test("MEDIUM: mic + browser frontmost on a NON-meeting URL", () => {
    const sig = computeSignal({
      frontmostBundleId: "com.google.Chrome",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: [],
      browserUrl: "https://example.com/",
    });
    expect(sig.confidence).toBe("MEDIUM");
  });

  test("MEDIUM: mic + browser frontmost on a meeting service HOMEPAGE (path-required regex bites)", () => {
    const sig = computeSignal({
      frontmostBundleId: "com.google.Chrome",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: [],
      browserUrl: "https://meet.google.com/about",
    });
    expect(sig.confidence).toBe("MEDIUM");
  });

  test("HIGH: mic + Comet (Perplexity's Chromium browser) frontmost on a real meeting URL", () => {
    // Regression for v0.7.0: Comet wasn't in BROWSERS, so a Meet room
    // opened in Comet stayed at MEDIUM (mic-only) and the popup never
    // fired. Comet uses the same Chromium AppleScript dialect as Chrome.
    const sig = computeSignal({
      frontmostBundleId: "ai.perplexity.comet",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: [],
      browserUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(sig.confidence).toBe("HIGH");
  });

  test("MEDIUM: mic + Comet frontmost on a NON-meeting URL", () => {
    const sig = computeSignal({
      frontmostBundleId: "ai.perplexity.comet",
      micInUse: true,
      runningCallAppsStrict: [],
      runningCallAppsSoft: [],
      browserUrl: "https://example.com/",
    });
    expect(sig.confidence).toBe("MEDIUM");
  });
});

describe("BROWSERS set", () => {
  test("includes Perplexity Comet (ai.perplexity.comet)", () => {
    expect(BROWSERS.has("ai.perplexity.comet")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Debounce semantics                                                         */
/* -------------------------------------------------------------------------- */

describe("MeetingDetector — debounce", () => {
  test("commit fires after the debounce window when the new state is stable", async () => {
    const edges: MeetingEdge[] = [];
    const det = new MeetingDetector({ debounceMs: 60, onEdge: (e) => edges.push(e) });

    await det.handleEvent(snapshot({ bundleId: "com.apple.Notes", micInUse: false }));
    // NONE -> HIGH transition.
    await det.handleEvent(frontmost("us.zoom.xos"));
    await det.handleEvent(micChanged(true));
    // No edge yet — still inside the debounce window.
    expect(edges).toHaveLength(0);
    await Bun.sleep(80);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from).toBe("NONE");
    expect(edges[0]?.to).toBe("HIGH");
    det.dispose();
  });

  test("flicker within the window does NOT commit (NONE -> HIGH -> NONE inside 1.5 s)", async () => {
    const edges: MeetingEdge[] = [];
    const det = new MeetingDetector({ debounceMs: 100, onEdge: (e) => edges.push(e) });

    await det.handleEvent(snapshot({ bundleId: "com.apple.Notes", micInUse: false }));
    // Brief mic flicker — Zoom flickers frontmost, mic flicks on, then off.
    await det.handleEvent(frontmost("us.zoom.xos"));
    await det.handleEvent(micChanged(true));
    // Half-way through the debounce window, it flips back.
    await Bun.sleep(40);
    await det.handleEvent(micChanged(false));
    // Wait past the original window — no edge should fire.
    await Bun.sleep(120);
    expect(edges).toHaveLength(0);
    det.dispose();
  });

  test("stable HIGH for one window then stable NONE for another commits both edges in order", async () => {
    const edges: MeetingEdge[] = [];
    const det = new MeetingDetector({ debounceMs: 60, onEdge: (e) => edges.push(e) });

    await det.handleEvent(snapshot({ bundleId: "com.apple.Notes", micInUse: false }));
    await det.handleEvent(frontmost("us.zoom.xos"));
    await det.handleEvent(micChanged(true));
    await Bun.sleep(80);
    // NONE -> HIGH committed.
    expect(edges.map((e) => e.to)).toEqual(["HIGH"]);

    // Now leave the meeting.
    await det.handleEvent(micChanged(false));
    await Bun.sleep(80);
    expect(edges.map((e) => e.to)).toEqual(["HIGH", "NONE"]);
    expect(edges[1]?.from).toBe("HIGH");
    det.dispose();
  });

  test("intermediate MEDIUM during a flicker cancels the pending HIGH edge", async () => {
    const edges: MeetingEdge[] = [];
    const det = new MeetingDetector({ debounceMs: 100, onEdge: (e) => edges.push(e) });

    await det.handleEvent(snapshot({ bundleId: "com.apple.Notes", micInUse: false }));
    // Trigger NONE -> HIGH via Zoom frontmost + mic in use.
    await det.handleEvent(frontmost("us.zoom.xos"));
    await det.handleEvent(micChanged(true));
    // Mid-window, switch to Notes — no longer HIGH-eligible (mic still
    // on, but the running set is empty and no browser URL): falls to
    // MEDIUM, which should restart the timer toward MEDIUM, not let
    // the original HIGH edge land.
    await Bun.sleep(40);
    await det.handleEvent(frontmost("com.apple.Notes"));
    // The pending HIGH should be cancelled / re-aimed at MEDIUM. Wait
    // out the new window.
    await Bun.sleep(120);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.to).toBe("MEDIUM");
    det.dispose();
  });

  test("re-emitting the same edge target doesn't reset the debounce window", async () => {
    const edges: MeetingEdge[] = [];
    const det = new MeetingDetector({ debounceMs: 80, onEdge: (e) => edges.push(e) });

    await det.handleEvent(snapshot({ bundleId: "us.zoom.xos", micInUse: false }));
    await det.handleEvent(micChanged(true));
    // Spam the same Zoom-frontmost event a few times during the window.
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(10);
      await det.handleEvent(frontmost("us.zoom.xos"));
    }
    // ~50 ms have elapsed inside the 80 ms window. Wait the remainder.
    await Bun.sleep(50);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.to).toBe("HIGH");
    det.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Browser URL resolver invocation                                            */
/* -------------------------------------------------------------------------- */

describe("MeetingDetector — browser URL resolver gating", () => {
  test("does NOT query the URL when frontmost is not a known browser", async () => {
    let calls = 0;
    const det = new MeetingDetector({
      debounceMs: 0,
      resolveBrowserUrl: async () => {
        calls++;
        return null;
      },
    });
    await det.handleEvent(snapshot({ bundleId: "com.apple.Notes", micInUse: true }));
    expect(calls).toBe(0);
    det.dispose();
  });

  test("does NOT query the URL when mic is not in use", async () => {
    let calls = 0;
    const det = new MeetingDetector({
      debounceMs: 0,
      resolveBrowserUrl: async () => {
        calls++;
        return null;
      },
    });
    await det.handleEvent(snapshot({ bundleId: "com.google.Chrome", micInUse: false }));
    expect(calls).toBe(0);
    det.dispose();
  });

  test("does NOT query the URL when a strict call app is already running (corroborative noise)", async () => {
    let calls = 0;
    const det = new MeetingDetector({
      debounceMs: 0,
      resolveBrowserUrl: async () => {
        calls++;
        return null;
      },
    });
    await det.handleEvent(
      snapshot({
        bundleId: "com.google.Chrome",
        micInUse: true,
        strict: ["us.zoom.xos"],
      }),
    );
    expect(calls).toBe(0);
    det.dispose();
  });

  test("DOES query the URL when mic in use AND frontmost is a browser AND no strict running", async () => {
    let calls = 0;
    const det = new MeetingDetector({
      debounceMs: 0,
      resolveBrowserUrl: async (bid) => {
        calls++;
        expect(bid).toBe("com.google.Chrome");
        return "https://meet.google.com/abc-defg-hij";
      },
    });
    const sig = await det.handleEvent(
      snapshot({ bundleId: "com.google.Chrome", micInUse: true }),
    );
    expect(calls).toBe(1);
    expect(sig.confidence).toBe("HIGH");
    expect(sig.evidence.browser_url).toBe("https://meet.google.com/abc-defg-hij");
    det.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end stream replay                                                   */
/* -------------------------------------------------------------------------- */

describe("MeetingDetector — scripted event streams", () => {
  test("app_launched / app_terminated keep the running-set in sync", async () => {
    const det = new MeetingDetector({ debounceMs: 0 });
    await det.handleEvent(snapshot({ bundleId: "com.apple.Notes", micInUse: true }));
    expect(det.signal().confidence).toBe("MEDIUM");

    await det.handleEvent(launched("us.zoom.xos"));
    expect(det.signal().confidence).toBe("HIGH");

    await det.handleEvent(terminated("us.zoom.xos"));
    expect(det.signal().confidence).toBe("MEDIUM");
    det.dispose();
  });

  test("snapshot wipes the cached browser URL (it's stale)", async () => {
    const det = new MeetingDetector({
      debounceMs: 0,
      resolveBrowserUrl: async () => "https://meet.google.com/abc-defg-hij",
    });
    await det.handleEvent(snapshot({ bundleId: "com.google.Chrome", micInUse: true }));
    expect(det.signal().evidence.browser_url).toBe("https://meet.google.com/abc-defg-hij");

    // A re-snapshot must invalidate the cached URL even if the new state
    // happens to land on the same frontmost — the snapshot represents a
    // helper restart and we can't trust the old URL.
    await det.handleEvent(snapshot({ bundleId: "com.apple.Notes", micInUse: false }));
    expect(det.signal().evidence.browser_url).toBeNull();
    det.dispose();
  });

  test("snapshot directly producing HIGH commits after debounce", async () => {
    const edges: MeetingEdge[] = [];
    const det = new MeetingDetector({ debounceMs: 30, onEdge: (e) => edges.push(e) });
    await det.handleEvent(
      snapshot({
        bundleId: "us.zoom.xos",
        micInUse: true,
        strict: ["us.zoom.xos"],
      }),
    );
    await Bun.sleep(50);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from).toBe("NONE");
    expect(edges[0]?.to).toBe("HIGH");
    det.dispose();
  });
});
