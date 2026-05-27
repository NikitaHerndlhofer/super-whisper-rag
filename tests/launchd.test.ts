import { describe, expect, test } from "bun:test";
import { PLIST_LABEL, renderPlist } from "../src/launchd/plist.ts";

describe("renderPlist", () => {
  test("contains the watch Label, ProgramArguments, KeepAlive, RunAtLoad", () => {
    const xml = renderPlist({
      binPath: "/opt/homebrew/bin/swrag",
      user: "alice",
      logPath: "/Users/alice/Library/Logs/superwhisper-rag.log",
    });
    expect(PLIST_LABEL).toBe("com.superwhisper-rag.watch");
    expect(xml).toContain(`<string>${PLIST_LABEL}</string>`);
    expect(xml).toContain("/opt/homebrew/bin/swrag");
    expect(xml).toContain("<string>watch</string>");
    // Keepalive shape: KeepAlive=true, RunAtLoad=true, ThrottleInterval=30.
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<integer>30</integer>");
    expect(xml).toContain("/Users/alice/Library/Logs/superwhisper-rag.log");
  });

  test("does NOT contain StartInterval (periodic mode is gone in v1.0)", () => {
    const xml = renderPlist({
      binPath: "/opt/homebrew/bin/swrag",
      user: "alice",
      logPath: "/tmp/x.log",
    });
    expect(xml).not.toContain("StartInterval");
  });

  test("respects custom throttleSeconds", () => {
    const xml = renderPlist({
      binPath: "/opt/homebrew/bin/swrag",
      user: "alice",
      logPath: "/tmp/x.log",
      throttleSeconds: 5,
    });
    expect(xml).toContain("<integer>5</integer>");
  });

  test("escapes XML special chars in paths", () => {
    const xml = renderPlist({
      binPath: "/opt/<dir>/swrag",
      user: "x",
      logPath: "/tmp/x.log",
    });
    expect(xml).toContain("/opt/&lt;dir&gt;/swrag");
  });
});
