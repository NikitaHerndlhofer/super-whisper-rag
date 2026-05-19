import { describe, expect, test } from "bun:test";
import { PLIST_LABEL, renderPlist } from "../src/launchd/plist.ts";

describe("renderPlist", () => {
  test("contains the Label, ProgramArguments, RunAtLoad, StartInterval", () => {
    const xml = renderPlist({
      binPath: "/opt/homebrew/bin/swrag",
      user: "alice",
      logPath: "/Users/alice/Library/Logs/superwhisper-rag.log",
    });
    expect(xml).toContain(`<string>${PLIST_LABEL}</string>`);
    expect(xml).toContain("/opt/homebrew/bin/swrag");
    expect(xml).toContain("<string>index</string>");
    expect(xml).toContain("<integer>3600</integer>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("/Users/alice/Library/Logs/superwhisper-rag.log");
  });

  test("respects custom interval", () => {
    const xml = renderPlist({
      binPath: "/opt/homebrew/bin/swrag",
      user: "alice",
      logPath: "/tmp/x.log",
      intervalSeconds: 600,
    });
    expect(xml).toContain("<integer>600</integer>");
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
