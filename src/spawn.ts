/**
 * Tiny wrapper around `Bun.spawnSync` that returns decoded `stdout`/`stderr`
 * strings instead of `ArrayBuffer`s. Centralises the
 *
 *   const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
 *
 * incantation that otherwise appears at every call site.
 *
 * For commands whose stdio we want to inherit from the parent process
 * (REPL launches, build sub-processes), use `Bun.spawnSync` directly —
 * this helper always pipes.
 */
export interface RunResult {
  /**
   * Exit code (0–127) for a clean exit, or 128+signum for a signal
   * termination — same convention as the shell. Used to be flattened to
   * 1 on any non-clean exit, which erased the distinction between a
   * `false`-style failure and a SIGKILL.
   */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Signal name when the process was killed by signal, else null. */
  signal: NodeJS.Signals | null;
}

export interface RunOptions {
  /** Per-process timeout in ms. */
  timeoutMs?: number;
}

export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  const r = Bun.spawnSync({
    cmd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.timeoutMs != null ? { timeout: opts.timeoutMs } : {}),
  });
  const signal = (r.signalCode ?? null) as NodeJS.Signals | null;
  let exitCode: number;
  if (r.exitCode != null) {
    exitCode = r.exitCode;
  } else if (signal != null) {
    exitCode = 128 + (signalNumber(signal) ?? 0);
  } else {
    exitCode = 1;
  }
  return {
    exitCode,
    signal,
    stdout: r.stdout ? new TextDecoder().decode(r.stdout) : "",
    stderr: r.stderr ? new TextDecoder().decode(r.stderr) : "",
  };
}

// Subset of POSIX signal numbers we actually expect to see. Anything not
// listed falls back to "0" (exitCode becomes 128), which is still a
// clear signal that something abnormal happened.
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 10,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return SIGNAL_NUMBERS[signal];
}
