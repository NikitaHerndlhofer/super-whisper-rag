import { homedir } from "node:os";

/**
 * Render the launchd plist that wraps `swrag watch` as a keepalive
 * agent. Pre-v1.0 we shipped a `StartInterval=3600` periodic plist
 * that triggered `swrag index`; v1.0 replaces it with an event-driven
 * daemon that owns its own lifecycle and just needs launchd to keep
 * it alive.
 *
 * Why a single mode? Pre-v1.0 distinguished "periodic" (the old
 * `enable-sync` agent) and "keepalive" (the meeting-watch daemon
 * that's now gone). With the meeting pipeline reverted and the
 * periodic agent retired, there's only one shape left — keep the
 * template tiny.
 *
 * Keepalive specifics:
 *   - `KeepAlive=true` → relaunch on exit, but
 *   - `ThrottleInterval=30` → wait 30s between relaunches. Stops a
 *     crash-looping binary from melting the CPU.
 *   - `RunAtLoad=true` → start at login (and immediately on `bootstrap`).
 *   - No `StartInterval` — the daemon stays resident and reacts to
 *     FSEvents itself.
 */
export interface PlistTemplate {
  /** Absolute path to the swrag binary. */
  binPath: string;
  /** Username — currently unused in the rendered XML, kept for parity with the previous template's signature. */
  user: string;
  /** Where launchd writes stdout/stderr. */
  logPath: string;
  /**
   * Throttle floor in seconds between relaunches. Tests override to
   * 0 to avoid waiting; production should leave the default.
   */
  throttleSeconds?: number;
}

export const PLIST_LABEL = "com.superwhisper-rag.watch";

export function renderPlist(t: PlistTemplate): string {
  const throttle = t.throttleSeconds ?? 30;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(t.binPath)}</string>
    <string>watch</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(t.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(t.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${escapeXml(homedir())}</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
