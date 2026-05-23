/**
 * Tiny client for the meeting daemon's unix socket.
 *
 * Used by the CLI (and tests) to dispatch one-shot ops to the daemon
 * if it's running. The protocol is the same line-delimited JSON the
 * Swift menubar consumes:
 *
 *   open connection
 *   write `{"op":"…"}\n`
 *   read one line of JSON
 *   close
 *
 * If the daemon isn't listening (ENOENT / ECONNREFUSED on the socket
 * file) `callDaemon` throws a `DaemonUnavailableError`; the CLI is
 * responsible for catching that and falling back to in-process
 * behavior (Phase 1's `processor.start()`, Phase 3's foreground
 * recorder, etc.).
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DAEMON_SOCKET = join(
  homedir(),
  "Library",
  "Application Support",
  "superwhisper-rag",
  "meeting.sock",
);

/* -------------------------------------------------------------------------- */
/* Error types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when the socket doesn't exist or the connection is refused.
 * The CLI catches this and falls back to direct in-process work.
 */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

/**
 * Thrown when the daemon responded but the response is structurally
 * malformed (not JSON, or doesn't fit the caller's schema). Callers
 * should treat this as a hard failure, not a fallback signal.
 */
export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonProtocolError";
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface CallDaemonOptions {
  /** Override socket path (test hook). Defaults to the user socket. */
  socketPath?: string;
  /** Per-call timeout in ms. Defaults to 30 s. */
  timeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Send `op` to the daemon and return the parsed JSON response. Caller
 * is responsible for validating the response shape (zod, typically)
 * since the daemon contract evolves independently of this module.
 */
export async function callDaemon<T = unknown>(
  op: object,
  opts: CallDaemonOptions = {},
): Promise<T> {
  const socketPath = opts.socketPath ?? DEFAULT_DAEMON_SOCKET;
  if (!existsSync(socketPath)) {
    throw new DaemonUnavailableError(`daemon socket does not exist: ${socketPath}`);
  }
  // A regular file at the socket path means an old plist run wrote a
  // .sock file by mistake — Bun.connect will fail with a confusing
  // error if we hand it a non-socket. Pre-check and produce a clean
  // unavailability error.
  const st = statSync(socketPath);
  if (!st.isSocket()) {
    throw new DaemonUnavailableError(
      `path exists but is not a socket: ${socketPath} (left over from a previous version?)`,
    );
  }
  const line = `${JSON.stringify(op)}\n`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  return await runOneShot<T>(socketPath, line, timeoutMs);
}

/**
 * Quick liveness check. Returns true iff a `status` op round-trips
 * with a non-error response. Catches both unavailable and protocol
 * errors — the only way this returns true is if a real daemon
 * answered. Used by the CLI to decide whether to route through the
 * daemon or fall back to in-process behaviour.
 */
export async function isDaemonRunning(opts: CallDaemonOptions = {}): Promise<boolean> {
  try {
    await callDaemon({ op: "status" }, { ...opts, timeoutMs: opts.timeoutMs ?? 1_500 });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Connect, send one line, read one line, close. Mirrors the framing
 * the Swift menubar uses for its one-shot ops.
 */
async function runOneShot<T>(socketPath: string, line: string, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let socket: { end: () => void; write: (data: string) => void } | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket?.end();
      } catch {
        // best-effort
      }
      reject(new DaemonProtocolError(`daemon op timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Allow the process to exit normally even if the daemon is hung.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    const finish = (err: Error | null, result: T | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        // best-effort
      }
      if (err) reject(err);
      else if (result !== undefined) resolve(result);
      else reject(new DaemonProtocolError("daemon closed without sending a response"));
    };

    const onData = (data: ArrayBuffer | Uint8Array | string): void => {
      const chunk =
        typeof data === "string"
          ? data
          : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data));
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const responseLine = buffer.slice(0, nl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseLine);
      } catch (e) {
        finish(
          new DaemonProtocolError(
            `daemon response was not valid JSON: ${e instanceof Error ? e.message : String(e)} (line=${JSON.stringify(responseLine)})`,
          ),
          undefined,
        );
        return;
      }
      finish(null, parsed as T);
    };

    try {
      // Bun.connect with `unix` opens a unix-domain stream socket.
      // Same framing as the menubar's connection in Swift.
      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            socket = s;
            s.write(line);
          },
          data(_s, chunk) {
            onData(chunk);
          },
          end(_s) {
            // Server closed cleanly. If we still haven't decoded a
            // response (no newline received) this is a protocol error.
            if (!settled) {
              if (buffer.length > 0) {
                onData("\n");
              }
              finish(
                new DaemonProtocolError("daemon closed connection without a complete response"),
                undefined,
              );
            }
          },
          close(_s) {
            if (!settled) {
              finish(
                new DaemonProtocolError("daemon closed connection before responding"),
                undefined,
              );
            }
          },
          error(_s, err) {
            if (!settled) {
              const msg = err instanceof Error ? err.message : String(err);
              const errno = (err as { code?: string }).code;
              if (errno === "ENOENT" || errno === "ECONNREFUSED") {
                finish(new DaemonUnavailableError(`daemon socket not listening: ${msg}`), undefined);
              } else {
                finish(new DaemonProtocolError(`daemon socket error: ${msg}`), undefined);
              }
            }
          },
        },
      }).catch((err: unknown) => {
        if (!settled) {
          const msg = err instanceof Error ? err.message : String(err);
          const errno = (err as { code?: string }).code;
          if (errno === "ENOENT" || errno === "ECONNREFUSED") {
            finish(new DaemonUnavailableError(`daemon socket not listening: ${msg}`), undefined);
          } else {
            finish(new DaemonProtocolError(`failed to connect to daemon: ${msg}`), undefined);
          }
        }
      });
    } catch (err) {
      finish(
        new DaemonProtocolError(
          `failed to connect to daemon: ${err instanceof Error ? err.message : String(err)}`,
        ),
        undefined,
      );
    }
  });
}
