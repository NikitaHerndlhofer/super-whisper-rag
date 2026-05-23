import { describe, expect, test } from "bun:test";
import {
  MEETING_MENUBAR_PLIST_LABEL,
  MEETING_WATCH_PLIST_LABEL,
  renderPlist,
} from "../src/launchd/plist.ts";

describe("renderPlist", () => {
  test("watch agent: KeepAlive + RunAtLoad + ThrottleInterval; no StartInterval", () => {
    const xml = renderPlist({
      label: MEETING_WATCH_PLIST_LABEL,
      binPath: "/opt/homebrew/bin/swrag",
      programArguments: ["meeting", "watch"],
      logPath: "/tmp/x.log",
    });
    expect(xml).toContain(`<string>${MEETING_WATCH_PLIST_LABEL}</string>`);
    expect(xml).toContain("<string>meeting</string>");
    expect(xml).toContain("<string>watch</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>ThrottleInterval</key>");
    expect(xml).toContain("<integer>30</integer>");
    // Critical: a keepalive plist must NOT also set StartInterval —
    // launchd would interpret that as a both-fire periodic + respawn,
    // which is not what we want. Phase 5 deleted the periodic mode
    // entirely, but we keep the assertion as a regression guard.
    expect(xml).not.toContain("<key>StartInterval</key>");
  });

  test("menubar agent: custom throttle interval is honoured", () => {
    const xml = renderPlist({
      label: MEETING_MENUBAR_PLIST_LABEL,
      binPath: "/opt/homebrew/bin/swrag",
      programArguments: ["meeting", "menubar"],
      logPath: "/tmp/x.log",
      throttleIntervalSeconds: 60,
    });
    expect(xml).toContain(`<string>${MEETING_MENUBAR_PLIST_LABEL}</string>`);
    expect(xml).toContain("<integer>60</integer>");
  });

  test("escapes XML special chars in paths", () => {
    const xml = renderPlist({
      label: MEETING_WATCH_PLIST_LABEL,
      binPath: "/opt/<dir>/swrag",
      programArguments: ["meeting", "watch"],
      logPath: "/tmp/x.log",
    });
    expect(xml).toContain("/opt/&lt;dir&gt;/swrag");
  });
});
