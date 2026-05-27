/**
 * `swrag setup-signing` — re-sign the bundled Swift helper with the
 * user's own free Apple Development certificate.
 *
 * Why this command exists
 * -----------------------
 *
 * macOS Sequoia/Tahoe broke ScreenCaptureKit for ad-hoc-signed
 * binaries: `CGPreflightScreenCaptureAccess()` returns false even
 * when the user has toggled Screen Recording ON for our `.app`
 * bundle in System Settings. The documented workaround — free
 * Apple Developer cert via Xcode + Personal Team — produces a
 * stable Team ID that TCC keeps grants attached to across all
 * future swrag upgrades. The cert is free; the paid Apple
 * Developer Program is NOT required for local-machine signing.
 *
 * Flow
 * ----
 *
 * 1. Locate an `Apple Development: …` identity via
 *    `security find-identity -v -p codesigning`.
 * 2. If 0 identities, print clear setup instructions and exit 0
 *    (this is the most common first-run state — the user hasn't
 *    installed Xcode yet).
 * 3. If ≥1 identities, pick the first one (we keep the UX simple
 *    on purpose; users with multiple certs can re-order via Xcode's
 *    keychain UI).
 * 4. Run `codesign --force --deep --sign <identity> --options
 *    runtime <helper.app>`. `--options runtime` enables the
 *    hardened runtime, which some TCC paths in Tahoe require for
 *    Screen Recording attribution to land correctly.
 * 5. Persist `signing_identity=<hash>` in the archive's `config`
 *    table. Every subsequent `materialiseHelper` reads this and
 *    re-applies the signature, so all future `brew upgrade` cycles
 *    keep working without re-running this command.
 * 6. Print next-steps: kickstart the watcher, drag the .app into
 *    System Settings → Screen Recording, verify with
 *    `swrag meeting permissions-check`.
 *
 * Idempotent. Re-runs land cleanly: codesign re-signs in place; the
 * config key is upserted.
 */
import { existsSync } from "node:fs";
import { openArchive, setConfig } from "../archive/open.ts";
import { info } from "../log.ts";
import {
  CONFIG_SIGNING_IDENTITY,
  getHelperCacheDir,
  helperBinaryPath,
  helperSignatureInfo,
  runCodesign,
  type CodesignResult,
} from "../mac/helper.ts";

/**
 * One parsed `security find-identity` row.
 *
 * `security` prints identities as
 *   `  1) <SHA-1-hex> "Apple Development: First Last (TEAMID12AB)"`
 * for valid codesigning identities. We strip out the parenthesised
 * team id into its own field so the success line can render it
 * verbatim without re-parsing.
 */
export interface SigningIdentity {
  /** SHA-1 hex of the identity. This is what `codesign --sign` takes. */
  hash: string;
  /** Verbatim CN — e.g. `Apple Development: Some Name (TEAMID12AB)`. */
  fullName: string;
  /** Short display name without the trailing team id. */
  displayName: string;
  /** Team id parsed out of the trailing `(…)` — null on parse failure. */
  teamId: string | null;
}

export interface SetupSigningOptions {
  /** Path to the archive that holds the `config` table. */
  archive: string;
  /**
   * Override `security find-identity -v -p codesigning` output for
   * tests. Real callers don't pass this.
   */
  findIdentities?: () => SigningIdentity[];
  /**
   * Override the `codesign` invocation for tests. Real callers don't
   * pass this — `helperBinaryPath()` + `runCodesign()` are the
   * default production path.
   */
  codesign?: (appPath: string, identity: string) => CodesignResult;
  /**
   * Override the helper-path resolver. The default forces a
   * materialise via `helperBinaryPath()` (so the bundle is guaranteed
   * to be present on disk before we sign), then returns the parent
   * `.app/` directory.
   */
  resolveHelperApp?: () => string;
  /**
   * Override the line writer for tests. Defaults to `process.stdout`.
   */
  writeLine?: (line: string) => void;
}

export interface SetupSigningResult {
  exitCode: number;
  /** Identity hash we signed with, or null if signing was skipped. */
  identityHash: string | null;
  /** The identity row we chose, when there was one. */
  identity: SigningIdentity | null;
  /** Path to the (now-signed) helper bundle on disk. */
  appPath: string | null;
  /**
   * Reason the command ended where it did. Useful for tests; humans
   * see the formatted lines that this function also writes.
   */
  outcome:
    | "no_certs"
    | "signed"
    | "codesign_failed"
    | "no_helper";
}

const NO_CERT_MESSAGE = `No Apple Development certificate found on this machine.

To set one up (free, no paid Apple Developer program required):

  1. Install Xcode from the Mac App Store (free, ~12 GB).
  2. Open Xcode → Settings → Accounts → click "+" → choose "Apple ID".
  3. Sign in with your Apple ID (any free Apple ID works).
  4. Xcode auto-provisions a "Personal Team" with an "Apple Development" certificate.
  5. Re-run \`swrag setup-signing\`.

This certificate stays valid for ~1 year and renews automatically while Xcode is signed in.`;

export async function runSetupSigning(
  opts: SetupSigningOptions,
): Promise<SetupSigningResult> {
  const find = opts.findIdentities ?? defaultFindIdentities;
  const codesign = opts.codesign ?? runCodesign;
  const writeLine = opts.writeLine ?? ((s: string) => process.stdout.write(`${s}\n`));

  const identities = find();
  if (identities.length === 0) {
    for (const line of NO_CERT_MESSAGE.split("\n")) writeLine(line);
    return {
      exitCode: 0,
      identityHash: null,
      identity: null,
      appPath: null,
      outcome: "no_certs",
    };
  }

  // Multiple certs? List them, pick the first. We default to "first"
  // rather than an interactive prompt because:
  //   - 99% of users have exactly one cert (the Personal Team one
  //     Xcode auto-generates), so an extra prompt is pure friction.
  //   - When a user genuinely has multiple, they can re-order via
  //     Xcode's keychain UI before re-running; or they can pass
  //     `SWRAG_SIGN_IDENTITY` explicitly to the build pipeline.
  if (identities.length > 1) {
    writeLine(`Found ${identities.length} Apple Development certificates:`);
    for (let i = 0; i < identities.length; i++) {
      const id = identities[i];
      if (id) writeLine(`  ${i + 1}. ${id.fullName}`);
    }
    writeLine(`Picking the first one: ${identities[0]?.fullName ?? "?"}`);
    writeLine("");
  }

  const identity = identities[0];
  if (identity == null) {
    // Defensive — TypeScript narrowing only.
    for (const line of NO_CERT_MESSAGE.split("\n")) writeLine(line);
    return {
      exitCode: 0,
      identityHash: null,
      identity: null,
      appPath: null,
      outcome: "no_certs",
    };
  }

  // Force a materialise of the helper bundle so we have a concrete
  // path to sign. helperBinaryPath() extracts the embedded tarball
  // to the persistent cache (~/Library/Application Support/...).
  const resolveApp = opts.resolveHelperApp ?? defaultResolveHelperApp;
  let appPath: string;
  try {
    appPath = resolveApp();
  } catch (e) {
    writeLine(
      `Could not locate the helper bundle: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    writeLine("Re-run after a successful `swrag bootstrap`.");
    return {
      exitCode: 1,
      identityHash: null,
      identity,
      appPath: null,
      outcome: "no_helper",
    };
  }

  info(`signing ${appPath} with ${identity.fullName}`);
  const r = codesign(appPath, identity.hash);
  if (!r.ok) {
    writeLine(`codesign failed: ${r.message}`);
    writeLine("");
    writeLine(
      "Common fixes: ensure your Apple Development certificate isn't expired " +
        "(Xcode → Settings → Accounts → Manage Certificates), then re-run.",
    );
    return {
      exitCode: 1,
      identityHash: null,
      identity,
      appPath,
      outcome: "codesign_failed",
    };
  }

  // Persist the identity hash so every future `materialiseHelper`
  // re-applies it. setConfig upserts — repeat runs are clean.
  const db = openArchive(opts.archive, {});
  try {
    setConfig(db, CONFIG_SIGNING_IDENTITY, identity.hash);
  } finally {
    db.close();
  }

  // Success summary. Match the README + spec verbatim so a user
  // searching for one of these lines can find the other.
  writeLine("");
  writeLine(`✓ Helper signed with: ${identity.fullName}`);
  writeLine("");
  writeLine("Next steps:");
  writeLine("");
  writeLine(
    "  1. Restart the meeting watcher:",
  );
  writeLine(
    "       launchctl kickstart -k gui/$(id -u)/com.superwhisper-rag.meeting-watch",
  );
  writeLine(
    "  2. Grant Screen Recording: open System Settings → Privacy & Security →",
  );
  writeLine(
    "     Screen Recording → drag the helper from",
  );
  writeLine(`       ${appPath}`);
  writeLine("     into the list, toggle ON.");
  writeLine(
    "  3. Verify: swrag meeting permissions-check  # should now show screen_recording: \"granted\"",
  );

  return {
    exitCode: 0,
    identityHash: identity.hash,
    identity,
    appPath,
    outcome: "signed",
  };
}

/**
 * Default helper-path resolver. Forces materialisation by calling
 * `helperBinaryPath()` (which extracts the embedded tarball on first
 * use), then returns the enclosing `.app/` directory. Falls back to
 * the cache dir on resolution failure so we still have something to
 * sign in dev mode.
 */
function defaultResolveHelperApp(): string {
  // Side-effecting call: materialises the bundle if it isn't there
  // yet. Throws if it can't (which surfaces as a clean error above).
  helperBinaryPath();
  const cache = getHelperCacheDir();
  const app = `${cache}/swrag-helper.app`;
  if (!existsSync(app)) {
    throw new Error(`expected materialised helper at ${app} but it's missing`);
  }
  return app;
}

/**
 * Parse `security find-identity -v -p codesigning` output.
 *
 * Output shape (current macOS, stable for years):
 *
 *   ```
 *     1) ABC123HEX "Apple Development: Some Name (TEAMID12AB)"
 *     2) DEF456HEX "Some Other Identity"
 *        2 valid identities found
 *   ```
 *
 * We accept any line matching `<index>) <hash> "<full-name>"` and
 * filter to those whose name starts with `Apple Development:` (the
 * spec's exact wording — paid Developer ID identities have a
 * different prefix and are NOT what we want here).
 *
 * Exported for tests that want to exercise the parser directly.
 */
export function parseSecurityFindIdentityOutput(stdout: string): SigningIdentity[] {
  const out: SigningIdentity[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    // `1) HASH "Apple Development: …"` — index is at least one digit.
    const m = line.match(/^\d+\)\s+([0-9A-Fa-f]{8,})\s+"([^"]+)"\s*$/);
    if (!m) continue;
    const hash = m[1];
    const fullName = m[2];
    if (hash == null || fullName == null) continue;
    if (!/^Apple Development:/i.test(fullName)) continue;
    const teamMatch = fullName.match(/\(([^()]+)\)\s*$/);
    const teamId = teamMatch?.[1] ?? null;
    const displayName = teamMatch
      ? fullName.slice(0, fullName.length - teamMatch[0].length).trim()
      : fullName;
    out.push({ hash, fullName, displayName, teamId });
  }
  return out;
}

function defaultFindIdentities(): SigningIdentity[] {
  const r = Bun.spawnSync({
    cmd: ["security", "find-identity", "-v", "-p", "codesigning"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    // `security` exits 0 even with zero identities (it just prints
    // "  0 valid identities found"). A non-zero exit means a real
    // failure (binary missing, etc.) — surface as empty so the user
    // sees the helpful "install Xcode" message rather than a stack
    // trace. The `find-identity` subcommand has been stable since
    // macOS 10.5; we don't expect this branch in practice.
    return [];
  }
  return parseSecurityFindIdentityOutput(new TextDecoder().decode(r.stdout));
}

/**
 * Best-effort one-line description of the helper's current signature
 * for the bootstrap-prompt and doctor checks. Returns null if the
 * helper isn't on disk yet (e.g. nobody has invoked the CLI before).
 */
export function currentHelperSignatureSummary(): string | null {
  const cache = getHelperCacheDir();
  const app = `${cache}/swrag-helper.app`;
  if (!existsSync(app)) return null;
  const info = helperSignatureInfo(app);
  if (info == null) return null;
  if (info.adhoc || info.authority == null) {
    return "ad-hoc";
  }
  if (info.teamIdentifier != null) {
    return `${info.authority} (Team ${info.teamIdentifier})`;
  }
  return info.authority;
}
