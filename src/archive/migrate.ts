/**
 * Migration runner.
 *
 * Uses SQLite's built-in `PRAGMA user_version` as the source of truth for
 * "which migrations have already been applied to this archive". `0` is the
 * default for a never-touched DB; we bump it to each migration's `version`
 * inside the same transaction that applies the migration's SQL, so a
 * partially-applied migration rolls back cleanly.
 *
 * Each migration may contain many statements (the SQL parser handles
 * trigger bodies and CREATE VIRTUAL TABLE definitions). We split on
 * top-level `;` boundaries — respecting BEGIN…END trigger bodies — and
 * run each statement individually. This lets us tolerate "duplicate
 * column" errors from `ALTER TABLE ADD COLUMN` (which has no IF NOT
 * EXISTS form), making migrations idempotent against archives that
 * gained the same columns through earlier ad-hoc code.
 */
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { verbose } from "../log.ts";
import { LATEST_VERSION, MIGRATIONS, type Migration } from "./migrations.ts";

const UserVersionRowSchema = z.object({ user_version: z.number().int() });

export interface MigrationOutcome {
  /** PRAGMA user_version before migrate ran. */
  fromVersion: number;
  /** PRAGMA user_version after migrate ran. */
  toVersion: number;
  /** Version numbers actually applied this run. */
  applied: number[];
}

export function runMigrations(db: Database): MigrationOutcome {
  const from = readUserVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const applied: number[] = [];
  for (const m of pending) {
    applyMigration(db, m);
    applied.push(m.version);
  }
  const to = readUserVersion(db);
  if (applied.length > 0) {
    verbose(`migrate: ${from} -> ${to} (applied ${applied.join(", ")})`);
  }
  return { fromVersion: from, toVersion: to, applied };
}

function applyMigration(db: Database, m: Migration): void {
  const statements = splitSqlStatements(m.sql);
  const tx = db.transaction(() => {
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed.length === 0) continue;
      try {
        db.exec(trimmed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/duplicate column/i.test(msg)) {
          // ALTER TABLE ADD COLUMN against an archive that already has
          // the column (pre-migration ad-hoc code applied it). Safe to
          // continue.
          continue;
        }
        throw new Error(
          `migration ${m.version} (${m.name}) failed at statement:\n${trimmed}\n${msg}`,
        );
      }
    }
    db.exec(`PRAGMA user_version = ${m.version}`);
  });
  tx();
}

function readUserVersion(db: Database): number {
  const raw: unknown = db.prepare("PRAGMA user_version").get();
  return UserVersionRowSchema.parse(raw).user_version;
}

/**
 * Split a SQL script into individual statements on top-level `;`
 * boundaries. Respects `BEGIN`…`END` trigger bodies (the semicolons
 * inside don't terminate the outer statement) and SQL's doubled-quote
 * escape inside string literals (`'it''s'`, `"col""umn"`). Inline `--`
 * line comments are stripped before tokenisation; C-style block
 * comments are not used in our migrations so are not handled.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  const stripped = stripLineComments(sql);
  let inString: '"' | "'" | null = null;
  let beginDepth = 0;
  let start = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch == null) continue;
    if (inString) {
      // SQL escapes a quote inside a quoted string by doubling it:
      // `'it''s'` is one literal containing `it's`. Skip the pair so
      // we don't prematurely close the string.
      if (ch === inString) {
        if (stripped[i + 1] === inString) {
          i++;
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (matchesKeyword(stripped, i, "BEGIN")) {
      beginDepth++;
    } else if (matchesKeyword(stripped, i, "END")) {
      if (beginDepth > 0) beginDepth--;
    } else if (ch === ";" && beginDepth === 0) {
      out.push(stripped.slice(start, i + 1));
      start = i + 1;
    }
  }
  const tail = stripped.slice(start);
  if (tail.trim().length > 0) out.push(tail);
  return out;
}

function stripLineComments(sql: string): string {
  // Remove anything from a double-hyphen to end-of-line. Strings cannot
  // span lines in our migrations, so this is safe without full string
  // tokenization.
  return sql
    .split("\n")
    .map((line) => {
      const idx = findLineCommentStart(line);
      return idx < 0 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function findLineCommentStart(line: string): number {
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === "-" && line[i + 1] === "-") return i;
  }
  return -1;
}

function matchesKeyword(s: string, i: number, kw: string): boolean {
  // Match a whole-word keyword (case insensitive) at position i.
  if (i + kw.length > s.length) return false;
  if (!isWordBoundary(s, i - 1) || !isWordBoundary(s, i + kw.length)) {
    return false;
  }
  for (let k = 0; k < kw.length; k++) {
    const a = s[i + k]?.toUpperCase();
    const b = kw[k];
    if (a !== b) return false;
  }
  return true;
}

function isWordBoundary(s: string, idx: number): boolean {
  if (idx < 0 || idx >= s.length) return true;
  const ch = s[idx];
  if (ch == null) return true;
  return !/[A-Za-z0-9_]/.test(ch);
}

/** Visible to callers that want to know what's available without applying. */
export { LATEST_VERSION };
