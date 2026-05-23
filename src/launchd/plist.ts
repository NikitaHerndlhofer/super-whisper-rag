/**
 * launchd plist template.
 *
 * Keepalive only. The meeting watcher (`swrag meeting watch`) and the
 * menu bar (`swrag meeting menubar`) both run under `KeepAlive: true`;
 * if either crashes, launchd respawns it, gated by `ThrottleInterval`
 * (default 30 s) so a crash-loop doesn't burn CPU.
 *
 * The Phase 1–4 periodic-mode template (used by the deleted
 * `enable-sync` CLI) is gone — the meeting watcher's per-recording
 * targeted ingest plus the `ensureFresh()` mtime fast-path on every
 * `swrag sql` make the hourly cron redundant.
 *
 * The template is intentionally NOT in charge of choosing a label or
 * program arguments — those come from the caller. Each launch agent
 * gets its own (label, programArguments) pair. The label is also
 * used by `installLaunchAgent` to derive the plist path.
 */
import { homedir } from "node:os";

export const MEETING_WATCH_PLIST_LABEL = "com.superwhisper-rag.meeting-watch";
export const MEETING_MENUBAR_PLIST_LABEL = "com.superwhisper-rag.meeting-menubar";

/* -------------------------------------------------------------------------- */
/* Template                                                                   */
/* -------------------------------------------------------------------------- */

export interface PlistTemplate {
  label: string;
  binPath: string;
  programArguments: readonly string[];
  /** Where to log stdout/stderr. */
  logPath: string;
  /**
   * Minimum seconds between respawns. Defaults to 30 — that's the
   * value Phase 4 picked to keep a crash-loop from burning CPU.
   */
  throttleIntervalSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

export function renderPlist(t: PlistTemplate): string {
  const throttle = t.throttleIntervalSeconds ?? 30;
  const argsBlock = t.programArguments
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(t.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(t.binPath)}</string>
${argsBlock}
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
