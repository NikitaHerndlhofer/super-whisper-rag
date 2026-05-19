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
  exitCode: number;
  stdout: string;
  stderr: string;
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
  return {
    exitCode: r.exitCode ?? 1,
    stdout: r.stdout ? new TextDecoder().decode(r.stdout) : "",
    stderr: r.stderr ? new TextDecoder().decode(r.stderr) : "",
  };
}
