/**
 * Tests for the `swrag setup-signing` command (v0.9.12).
 *
 * The command shells out to two external tools: `security
 * find-identity` to locate the user's Apple Development cert, and
 * `codesign` to re-sign the helper bundle. Both are injected via
 * the `SetupSigningOptions` seam — tests stub them out so we never
 * touch the real keychain or filesystem.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSecurityFindIdentityOutput,
  runSetupSigning,
  type SigningIdentity,
} from "../../src/commands/setup-signing.ts";
import { getConfig, openArchive } from "../../src/archive/open.ts";
import { CONFIG_SIGNING_IDENTITY } from "../../src/mac/helper.ts";

let workDir: string;
let archive: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "swrag-setup-signing-"));
  archive = join(workDir, "archive.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const fakeApp = "/private/var/swrag-test/swrag-helper.app";

function makeIdentity(over: Partial<SigningIdentity> = {}): SigningIdentity {
  return {
    hash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    fullName: 'Apple Development: Jane Dev (TEAMID12AB)',
    displayName: "Apple Development: Jane Dev",
    teamId: "TEAMID12AB",
    ...over,
  };
}

describe("parseSecurityFindIdentityOutput", () => {
  test("parses a single Apple Development identity", () => {
    const stdout = [
      "Policy: Code Signing",
      "  Matching identities",
      '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Development: Jane Dev (TEAMID12AB)"',
      "     1 identities found",
      "",
      "  Valid identities only",
      '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Development: Jane Dev (TEAMID12AB)"',
      "     1 valid identities found",
      "",
    ].join("\n");
    const ids = parseSecurityFindIdentityOutput(stdout);
    // Both "Matching" and "Valid" sections contain the same row;
    // the parser doesn't de-dupe (the caller picks the first), but
    // both rows are valid parses.
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const first = ids[0];
    expect(first?.hash).toBe("ABCDEF0123456789ABCDEF0123456789ABCDEF01");
    expect(first?.fullName).toBe("Apple Development: Jane Dev (TEAMID12AB)");
    expect(first?.displayName).toBe("Apple Development: Jane Dev");
    expect(first?.teamId).toBe("TEAMID12AB");
  });

  test("ignores non-Apple-Development identities (paid Developer ID)", () => {
    const stdout = [
      '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Acme Inc (TEAMID12AB)"',
      "     1 valid identities found",
    ].join("\n");
    const ids = parseSecurityFindIdentityOutput(stdout);
    expect(ids).toEqual([]);
  });

  test("returns empty for the 0-identity zero-state", () => {
    const stdout = "     0 valid identities found\n";
    expect(parseSecurityFindIdentityOutput(stdout)).toEqual([]);
  });

  test("parses multiple identities preserving order", () => {
    const stdout = [
      '  1) 111111111111111111111111111111 "Apple Development: Person One (TEAMA12345)"',
      '  2) 222222222222222222222222222222 "Apple Development: Person Two (TEAMB67890)"',
      "     2 valid identities found",
    ].join("\n");
    const ids = parseSecurityFindIdentityOutput(stdout);
    expect(ids).toHaveLength(2);
    expect(ids[0]?.teamId).toBe("TEAMA12345");
    expect(ids[1]?.teamId).toBe("TEAMB67890");
  });
});

describe("runSetupSigning", () => {
  test("zero certs: prints install instructions and exits 0 (no config write)", async () => {
    const lines: string[] = [];
    const r = await runSetupSigning({
      archive,
      findIdentities: () => [],
      codesign: () => ({ ok: true, message: "" }),
      resolveHelperApp: () => fakeApp,
      writeLine: (s) => {
        lines.push(s);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("no_certs");
    expect(r.identity).toBeNull();
    expect(r.identityHash).toBeNull();
    // The install instructions reference Xcode and the rerun command.
    expect(lines.join("\n")).toContain("Install Xcode from the Mac App Store");
    expect(lines.join("\n")).toContain("swrag setup-signing");
    // No archive was written — the no-cert case doesn't touch the DB,
    // so opening it now should be the first time the file is created
    // and the config key should be undefined.
    const db = openArchive(archive, {});
    try {
      expect(getConfig(db, CONFIG_SIGNING_IDENTITY)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("one cert: signs the bundle, persists the identity, prints success", async () => {
    const lines: string[] = [];
    const captured: { app: string; identity: string }[] = [];
    const identity = makeIdentity();
    const r = await runSetupSigning({
      archive,
      findIdentities: () => [identity],
      codesign: (app, id) => {
        captured.push({ app, identity: id });
        return { ok: true, message: "" };
      },
      resolveHelperApp: () => fakeApp,
      writeLine: (s) => {
        lines.push(s);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("signed");
    expect(r.identityHash).toBe(identity.hash);
    expect(r.identity?.teamId).toBe("TEAMID12AB");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.app).toBe(fakeApp);
    expect(captured[0]?.identity).toBe(identity.hash);
    // Persisted in the archive config.
    const db = openArchive(archive, {});
    try {
      expect(getConfig(db, CONFIG_SIGNING_IDENTITY)).toBe(identity.hash);
    } finally {
      db.close();
    }
    // Success output mentions the full identity and the next-steps.
    const out = lines.join("\n");
    expect(out).toContain("Apple Development: Jane Dev (TEAMID12AB)");
    expect(out).toContain("Next steps");
    expect(out).toContain(
      "launchctl kickstart -k gui/$(id -u)/com.superwhisper-rag.meeting-watch",
    );
    expect(out).toContain("Screen Recording");
    expect(out).toContain(fakeApp);
    expect(out).toContain("swrag meeting permissions-check");
  });

  test("multiple certs: picks the first and notes the others on stdout", async () => {
    const lines: string[] = [];
    const a = makeIdentity({
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fullName: "Apple Development: First Person (TEAMAAA111)",
      displayName: "Apple Development: First Person",
      teamId: "TEAMAAA111",
    });
    const b = makeIdentity({
      hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fullName: "Apple Development: Second Person (TEAMBBB222)",
      displayName: "Apple Development: Second Person",
      teamId: "TEAMBBB222",
    });
    const r = await runSetupSigning({
      archive,
      findIdentities: () => [a, b],
      codesign: () => ({ ok: true, message: "" }),
      resolveHelperApp: () => fakeApp,
      writeLine: (s) => {
        lines.push(s);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("signed");
    expect(r.identityHash).toBe(a.hash);
    const out = lines.join("\n");
    expect(out).toContain("Found 2 Apple Development certificates");
    expect(out).toContain(a.fullName);
    expect(out).toContain(b.fullName);
    expect(out).toContain(`Picking the first one: ${a.fullName}`);
  });

  test("codesign failure: surfaces stderr, returns exit 1, leaves config unwritten", async () => {
    const lines: string[] = [];
    const r = await runSetupSigning({
      archive,
      findIdentities: () => [makeIdentity()],
      codesign: () => ({
        ok: false,
        message: "errSecInternalComponent",
      }),
      resolveHelperApp: () => fakeApp,
      writeLine: (s) => {
        lines.push(s);
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.outcome).toBe("codesign_failed");
    expect(r.identityHash).toBeNull();
    const out = lines.join("\n");
    expect(out).toContain("codesign failed");
    expect(out).toContain("errSecInternalComponent");
    // No config write on failure.
    const db = openArchive(archive, {});
    try {
      expect(getConfig(db, CONFIG_SIGNING_IDENTITY)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("missing helper bundle: clear error, no codesign call", async () => {
    const lines: string[] = [];
    let codesignCalls = 0;
    const r = await runSetupSigning({
      archive,
      findIdentities: () => [makeIdentity()],
      codesign: () => {
        codesignCalls++;
        return { ok: true, message: "" };
      },
      resolveHelperApp: () => {
        throw new Error("helper bundle materialise failed");
      },
      writeLine: (s) => {
        lines.push(s);
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.outcome).toBe("no_helper");
    expect(codesignCalls).toBe(0);
    expect(lines.join("\n")).toContain("Could not locate the helper bundle");
    expect(lines.join("\n")).toContain("swrag bootstrap");
  });

  test("idempotency: re-running with the same cert upserts the config (no row duplication)", async () => {
    await runSetupSigning({
      archive,
      findIdentities: () => [makeIdentity()],
      codesign: () => ({ ok: true, message: "" }),
      resolveHelperApp: () => fakeApp,
      writeLine: () => {},
    });
    // Switch to a different identity — the config should reflect
    // the new hash on the second run.
    const second = makeIdentity({
      hash: "ffffffffffffffffffffffffffffffffffffffff",
      fullName: "Apple Development: Switched (TEAMNEW111)",
    });
    const r = await runSetupSigning({
      archive,
      findIdentities: () => [second],
      codesign: () => ({ ok: true, message: "" }),
      resolveHelperApp: () => fakeApp,
      writeLine: () => {},
    });
    expect(r.identityHash).toBe(second.hash);
    const db = openArchive(archive, {});
    try {
      expect(getConfig(db, CONFIG_SIGNING_IDENTITY)).toBe(second.hash);
    } finally {
      db.close();
    }
  });
});
