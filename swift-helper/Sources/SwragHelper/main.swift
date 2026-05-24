import Foundation

// One-shot subcommands print a single JSON object and exit. The
// long-running `events` subcommand emits NDJSON (one object per line)
// on stdout until SIGTERM/SIGINT.
//
// Output is line-buffered so the TS daemon can consume events with
// minimal latency. Without this, stdout would be block-buffered by
// libc when piped (Bun.spawn pipes stdout) and the daemon would see
// events in bursts every ~4 KB instead of as they happen.
setlinebuf(stdout)

let args = CommandLine.arguments

func usage() {
  let msg = """
  usage: swrag-helper <command> [args...]

  commands:
    events                       long-running, emits NDJSON state events
    frontmost-app                one-shot, prints the current frontmost app
    mic-in-use                   one-shot, prints mic-in-use across all inputs
    permissions-check [--prompt] one-shot, probes mic / screen-recording /
                                   automation / notifications
    record --output <path>       long-running, mic+optional system audio recorder
           [--system-audio]      (off by default; opt-in for legal reasons)
    menubar [--socket <path>]    long-running, NSStatusItem menu bar subscriber
    notify --title <s> --body <s> [--actions a,b,...] [--default-action a]
           [--timeout N]         one-shot, UNUserNotificationCenter banner
                                   with action buttons; prints chosen
                                   action lowercased (or "timeout")
  """
  FileHandle.standardError.write(Data(msg.utf8))
  FileHandle.standardError.write(Data("\n".utf8))
}

guard args.count >= 2 else {
  usage()
  exit(2)
}

let command = args[1]
let rest = Array(args.dropFirst(2))

switch command {
case "events":
  runEvents()
case "frontmost-app":
  runFrontmostApp()
case "mic-in-use":
  runMicInUse()
case "permissions-check":
  let prompt = rest.contains("--prompt")
  runPermissionsCheck(prompt: prompt)
case "record":
  runRecord(args: rest)
case "menubar":
  runMenuBar(args: rest)
case "notify":
  runNotify(args: rest)
case "-h", "--help", "help":
  usage()
  exit(0)
default:
  FileHandle.standardError.write(Data("unknown command: \(command)\n".utf8))
  usage()
  exit(2)
}
