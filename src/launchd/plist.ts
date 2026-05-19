import { homedir } from "node:os";

export interface PlistTemplate {
  /** Absolute path to the swrag binary. */
  binPath: string;
  /** Username to substitute into log paths. */
  user: string;
  /** Where to log stdout/stderr. */
  logPath: string;
  /** Sync interval in seconds. */
  intervalSeconds?: number;
}

export const PLIST_LABEL = "com.superwhisper-rag.sync";

export function renderPlist(t: PlistTemplate): string {
  const interval = t.intervalSeconds ?? 3600;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(t.binPath)}</string>
    <string>index</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <true/>
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
