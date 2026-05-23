#!/usr/bin/env bash
#
# spike-sw-patcher.sh — throwaway investigation script for the meeting-capture
# pipeline plan's "Spike — Prove the SW patcher loop end-to-end" phase. See
# `docs/sw-patcher-spike.md` for documented findings.
#
# This script is kept in the repo so it can be re-run after a SuperWhisper
# upgrade to re-verify the assumptions baked into `src/meeting/patcher.ts`.
# It is NOT production code; it writes to SW's SQLite DB and meta.json.
#
# Idempotent caveats: each run leaves a NEW SW recording row in SW's DB with a
# patched (24h-in-the-past) datetime. The user can fix that via SW's UI or by
# running another patch. The script does NOT delete SW rows or recording
# folders.
#
# Requirements: sqlite3 (homebrew), python3, swrag installed, macOS.
# fswatch is optional; the script falls back to polling.

set -uo pipefail

SW_RECORDINGS="$HOME/Documents/superwhisper/recordings"
SW_DB="$HOME/Library/Application Support/superwhisper/database/superwhisper.sqlite"
SQLITE3="/opt/homebrew/opt/sqlite/bin/sqlite3"
TEST_SRC_WAV="$HOME/Documents/superwhisper/recordings/1779206778/output.wav"
TEST_WAV="/tmp/spike-sw-patcher.wav"
LOG="/tmp/spike-sw-patcher.log"
FOLDER_SNAP="/tmp/spike-sw-patcher.folders-before"

# Overall watcher timeout — 18min audio with Scribe (cloud) + LLM typically
# completes in well under 2min, but allow margin.
WATCH_TIMEOUT_S=900

# Per-iteration sleep in the watcher loop.
POLL_INTERVAL_S=0.2

: > "$LOG"

now_ts() { python3 -c 'import time; print(f"{time.time():.3f}")'; }

log() {
  local ts
  ts=$(now_ts)
  echo "[$ts] $*" | tee -a "$LOG"
}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 1
  }
}

require python3
require swrag
[[ -x "$SQLITE3" ]] || {
  echo "missing sqlite3 at $SQLITE3" >&2
  exit 1
}
[[ -f "$SW_DB" ]] || {
  echo "missing SW DB at $SW_DB" >&2
  exit 1
}
[[ -f "$TEST_SRC_WAV" ]] || {
  echo "missing test wav at $TEST_SRC_WAV" >&2
  exit 1
}

log "==============================================================="
log "spike-sw-patcher: throwaway end-to-end test of SW patching loop"
log "==============================================================="
log "SW_DB:         $SW_DB"
log "SW_RECORDINGS: $SW_RECORDINGS"
log "TEST_SRC_WAV:  $TEST_SRC_WAV"
log "TEST_WAV:      $TEST_WAV"
log "LOG:           $LOG"
log ""

###############################################################################
# STEP 1: snapshot SW state
###############################################################################
log "=== STEP 1: Snapshot SW state ==="
log ""
log "recording table schema (PRAGMA table_info):"
"$SQLITE3" "$SW_DB" "PRAGMA table_info(recording);" \
  | tee -a "$LOG"
log ""

# Capture the column list as a one-liner for the TESTED_SW_SCHEMA constant.
SCHEMA_COLS=$("$SQLITE3" "$SW_DB" "SELECT GROUP_CONCAT(name || ':' || type, ',') FROM pragma_table_info('recording');")
log "TESTED_SW_SCHEMA (one line): $SCHEMA_COLS"
log ""

log "appVersion distribution among recent rows (last 30 days):"
"$SQLITE3" "$SW_DB" "SELECT appVersion, COUNT(*) FROM recording WHERE datetime > date('now','-30 days') GROUP BY appVersion;" \
  | tee -a "$LOG"
LATEST_APPVER=$("$SQLITE3" "$SW_DB" "SELECT appVersion FROM recording ORDER BY datetime DESC LIMIT 1;")
log "latest appVersion: $LATEST_APPVER"
log ""

SNAP_COUNT=$("$SQLITE3" "$SW_DB" "SELECT COUNT(*) FROM recording;")
SNAP_MAXDT=$("$SQLITE3" "$SW_DB" "SELECT MAX(datetime) FROM recording;")
log "snapshot row count:     $SNAP_COUNT"
log "snapshot max(datetime): $SNAP_MAXDT"
log ""

ls "$SW_RECORDINGS" | sort > "$FOLDER_SNAP"
log "snapshot recording-folder count: $(wc -l < "$FOLDER_SNAP" | tr -d ' ')"

SNAP_SQLITE_MTIME=$(stat -f %m "$SW_DB")
log "snapshot SW SQLite mtime: $SNAP_SQLITE_MTIME ($(date -r "$SNAP_SQLITE_MTIME" "+%Y-%m-%d %H:%M:%S"))"
log ""

###############################################################################
# STEP 2: drop test wav into SW
###############################################################################
log "=== STEP 2: Drop test wav into SW ==="
cp "$TEST_SRC_WAV" "$TEST_WAV"
log "copied $TEST_SRC_WAV -> $TEST_WAV ($(stat -f %z "$TEST_WAV") bytes)"

T0=$(now_ts)
log "T0=$T0 — firing: open -a superwhisper $TEST_WAV"
open -a superwhisper "$TEST_WAV"
log ""

###############################################################################
# STEP 3: watch for folder + DB mtime + new row + transcription completion
###############################################################################
log "=== STEP 3: Watch SW dir + DB mtime ==="

NEW_FOLDER=""
FOLDER_DELTA=""
MTIME_DELTA=""
ROW_DELTA=""
DONE_DELTA=""
PRE_DONE_BUSY=0
PRE_DONE_PROBES=0
PROBE_EVERY=10   # probe SQLITE_BUSY every N iterations during waiting
PROBE_LOG="/tmp/spike-sw-patcher.busy-probe.log"
: > "$PROBE_LOG"

iter=0
while true; do
  iter=$((iter + 1))
  NOW=$(now_ts)
  ELAPSED=$(python3 -c "print(f'{${NOW} - ${T0}:.3f}')")

  if python3 -c "import sys; sys.exit(0 if ${NOW} - ${T0} > ${WATCH_TIMEOUT_S} else 1)"; then
    log "TIMEOUT after ${ELAPSED}s — bailing without seeing completion"
    break
  fi

  # New folder appeared in SW recordings dir?
  if [[ -z "$NEW_FOLDER" ]]; then
    NEW_LIST=$(comm -13 "$FOLDER_SNAP" <(ls "$SW_RECORDINGS" | sort))
    if [[ -n "$NEW_LIST" ]]; then
      NEW_FOLDER=$(echo "$NEW_LIST" | head -1)
      FOLDER_DELTA="$ELAPSED"
      log "EVENT folder_appeared: folderName=$NEW_FOLDER delta=${ELAPSED}s"
    fi
  fi

  # SW SQLite mtime moved?
  if [[ -z "$MTIME_DELTA" ]]; then
    CURRENT_MTIME=$(stat -f %m "$SW_DB")
    if [[ "$CURRENT_MTIME" != "$SNAP_SQLITE_MTIME" ]]; then
      MTIME_DELTA="$ELAPSED"
      log "EVENT sqlite_mtime_first_move: $SNAP_SQLITE_MTIME -> $CURRENT_MTIME delta=${ELAPSED}s"
    fi
  fi

  # New row appeared (any row with datetime > snapshot max)?
  if [[ -z "$ROW_DELTA" ]]; then
    LATEST=$("$SQLITE3" "$SW_DB" "SELECT folderName FROM recording WHERE datetime > '$SNAP_MAXDT' ORDER BY datetime DESC LIMIT 1;" 2>/dev/null || true)
    if [[ -n "$LATEST" ]]; then
      ROW_DELTA="$ELAPSED"
      log "EVENT new_row_appeared: folderName=$LATEST delta=${ELAPSED}s"
      if [[ -z "$NEW_FOLDER" ]]; then
        log "  (folder hadn't been detected on disk yet — using DB folderName)"
        NEW_FOLDER="$LATEST"
      fi
    fi
  fi

  # Probe SQLITE_BUSY periodically while SW is busy (between row_appeared and done).
  if [[ -n "$NEW_FOLDER" && -z "$DONE_DELTA" && $((iter % PROBE_EVERY)) -eq 0 ]]; then
    PRE_DONE_PROBES=$((PRE_DONE_PROBES + 1))
    OUT=$("$SQLITE3" "$SW_DB" "PRAGMA busy_timeout=5000; UPDATE recording SET datetime = datetime WHERE folderName = '$NEW_FOLDER';" 2>&1 || true)
    if [[ -n "$OUT" ]]; then
      echo "[$ELAPSED] probe iter=$iter: $OUT" >> "$PROBE_LOG"
      if echo "$OUT" | grep -qiE "busy|lock"; then
        PRE_DONE_BUSY=$((PRE_DONE_BUSY + 1))
      fi
    fi
  fi

  # Row transcribed (processingTime AND rawResult populated)?
  if [[ -n "$NEW_FOLDER" && -z "$DONE_DELTA" ]]; then
    DONE=$("$SQLITE3" "$SW_DB" "SELECT 1 FROM recording r JOIN recording_fts fts ON fts.recordingId = r.id WHERE r.folderName='$NEW_FOLDER' AND r.processingTime IS NOT NULL AND length(fts.rawResult) > 0 LIMIT 1;" 2>/dev/null || true)
    if [[ -n "$DONE" ]]; then
      DONE_DELTA="$ELAPSED"
      log "EVENT row_completed: folderName=$NEW_FOLDER delta=${ELAPSED}s"
      break
    fi
  fi

  sleep "$POLL_INTERVAL_S"
done

log ""
log "summary of step 3:"
log "  folder_appeared delta:        ${FOLDER_DELTA:-NEVER}s"
log "  sqlite_mtime_first_move delta: ${MTIME_DELTA:-NEVER}s"
log "  new_row_appeared delta:       ${ROW_DELTA:-NEVER}s"
log "  row_completed delta:          ${DONE_DELTA:-NEVER}s"
log "  pre-done BUSY probes:         $PRE_DONE_BUSY / $PRE_DONE_PROBES"
log "  probe log: $PROBE_LOG"
log ""

if [[ -z "$NEW_FOLDER" ]]; then
  log "FATAL: no new SW folder/row detected; cannot continue"
  rm -f "$TEST_WAV"
  exit 1
fi
if [[ -z "$DONE_DELTA" ]]; then
  log "WARN: row never reached completed state; continuing with patch anyway"
fi

###############################################################################
# STEP 4: write-lock contention
###############################################################################
log "=== STEP 4: Write-lock contention probe (post-completion) ==="

log "noop UPDATE without busy_timeout..."
OUT=$("$SQLITE3" "$SW_DB" "UPDATE recording SET datetime = datetime WHERE folderName = '$NEW_FOLDER';" 2>&1 || true)
log "  result: '${OUT:-<empty/ok>}'"

log "noop UPDATE with busy_timeout=5000..."
OUT=$("$SQLITE3" "$SW_DB" "PRAGMA busy_timeout=5000; UPDATE recording SET datetime = datetime WHERE folderName = '$NEW_FOLDER';" 2>&1 || true)
log "  result: '${OUT:-<empty/ok>}'"

log "SAVEPOINT + ROLLBACK roundtrip..."
OUT=$("$SQLITE3" "$SW_DB" "PRAGMA busy_timeout=5000; SAVEPOINT spike; UPDATE recording SET datetime = '2000-01-01 00:00:00.000' WHERE folderName = '$NEW_FOLDER'; ROLLBACK TO spike; RELEASE spike; SELECT datetime FROM recording WHERE folderName = '$NEW_FOLDER';" 2>&1 || true)
log "  result (post-rollback datetime should match pre-rollback):"
echo "$OUT" | sed 's/^/    /' | tee -a "$LOG"

log "burst test: 20 rapid noop UPDATEs..."
BURST_BUSY=0
for i in $(seq 1 20); do
  OUT=$("$SQLITE3" "$SW_DB" "PRAGMA busy_timeout=5000; UPDATE recording SET datetime = datetime WHERE folderName = '$NEW_FOLDER';" 2>&1 || true)
  if echo "$OUT" | grep -qiE "busy|lock"; then
    BURST_BUSY=$((BURST_BUSY + 1))
    log "  iter $i: $OUT"
  fi
done
log "burst BUSY count: $BURST_BUSY / 20"
log ""

###############################################################################
# STEP 5: perform the actual patch
###############################################################################
log "=== STEP 5: Patch datetime + meta.json ==="

FAKE_DATETIME=$(date -u -v-24H +"%Y-%m-%d %H:%M:%S.000")
log "fake datetime (24h ago, UTC): $FAKE_DATETIME"

log "pre-patch row:"
"$SQLITE3" -box "$SW_DB" "SELECT folderName, datetime, appVersion, modeName, processingTime, length(prompt) AS prompt_len FROM recording WHERE folderName='$NEW_FOLDER';" \
  | tee -a "$LOG"

log "applying UPDATE..."
OUT=$("$SQLITE3" "$SW_DB" "PRAGMA busy_timeout=5000; UPDATE recording SET datetime = '$FAKE_DATETIME' WHERE folderName = '$NEW_FOLDER';" 2>&1 || true)
log "  result: '${OUT:-<empty/ok>}'"

log "post-UPDATE row:"
"$SQLITE3" -box "$SW_DB" "SELECT folderName, datetime FROM recording WHERE folderName='$NEW_FOLDER';" \
  | tee -a "$LOG"

# Snapshot the post-UPDATE datetime so we can detect post-processing rewrites later.
POST_UPDATE_DT=$("$SQLITE3" "$SW_DB" "SELECT datetime FROM recording WHERE folderName='$NEW_FOLDER';")
log "captured post-update datetime: $POST_UPDATE_DT"

META="$SW_RECORDINGS/$NEW_FOLDER/meta.json"
if [[ -f "$META" ]]; then
  log "patching meta.json: $META"
  OLD_META_DT=$(python3 -c "import json; print(json.load(open('$META')).get('datetime'))")
  log "  meta.json old datetime: $OLD_META_DT"
  python3 - <<EOF
import json, os
path = "$META"
with open(path) as f:
    data = json.load(f)
data["datetime"] = "$FAKE_DATETIME"
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
os.rename(tmp, path)
EOF
  NEW_META_DT=$(python3 -c "import json; print(json.load(open('$META')).get('datetime'))")
  log "  meta.json new datetime: $NEW_META_DT"
else
  log "WARN: meta.json not found at $META — skipping meta patch"
fi
log ""

# Recheck DB datetime in case SW rewrote it after our UPDATE.
sleep 1
RECHECK_DT=$("$SQLITE3" "$SW_DB" "SELECT datetime FROM recording WHERE folderName='$NEW_FOLDER';")
log "datetime re-read 1s after patch: $RECHECK_DT (expected $FAKE_DATETIME)"
if [[ "$RECHECK_DT" != "$FAKE_DATETIME" ]]; then
  log "  *** WARN: SW clobbered the patched datetime; this is a structural problem"
fi
log ""

###############################################################################
# STEP 6: confirm §1.1 bulk-ingest bug
###############################################################################
log "=== STEP 6: Confirm §1.1 bulk-ingest bug ==="

LAST_INDEXED=$(swrag sql "SELECT value FROM config WHERE key='last_indexed_datetime';" 2>/dev/null)
log "swrag last_indexed_datetime (BEFORE index): $LAST_INDEXED"
log "patched datetime:                            $FAKE_DATETIME"
log "(patched is 24h behind, so it is < last_indexed_datetime by design)"
log ""

log "running 'swrag index'..."
swrag index 2>&1 | tee -a "$LOG"
log ""

LAST_INDEXED_AFTER=$(swrag sql "SELECT value FROM config WHERE key='last_indexed_datetime';" 2>/dev/null)
log "swrag last_indexed_datetime (AFTER index):  $LAST_INDEXED_AFTER"

log "swrag archive lookup for patched folder:"
swrag sql -- -box "SELECT folder_name, datetime, indexed_at, has_audio FROM recording WHERE folder_name='$NEW_FOLDER';" 2>&1 | tee -a "$LOG"

ROW_IN_ARCHIVE=$(swrag sql "SELECT COUNT(*) FROM recording WHERE folder_name='$NEW_FOLDER';" 2>/dev/null)
log "row-in-archive count for $NEW_FOLDER: $ROW_IN_ARCHIVE"
log ""

if [[ "$ROW_IN_ARCHIVE" == "0" ]]; then
  log "RESULT: bug CONFIRMED — patched row was silently dropped by bulk ingest"
else
  log "RESULT: row IS in archive — bug not reproduced this run; investigate:"
  swrag sql -- -box "SELECT folder_name, datetime FROM recording WHERE folder_name='$NEW_FOLDER';" | tee -a "$LOG"
fi
log ""

###############################################################################
# STEP 7: cleanup
###############################################################################
log "=== STEP 7: Cleanup ==="
if [[ -f "$TEST_WAV" ]]; then
  rm -f "$TEST_WAV"
  log "removed $TEST_WAV"
fi
log "leaving SW DB row + recording folder in place (folderName=$NEW_FOLDER)"
log "  the row's datetime is patched to $FAKE_DATETIME — user can restore manually if desired"
log ""

log "==============================================================="
log "spike complete. summary:"
log "  test folder:                $NEW_FOLDER"
log "  tested SW appVersion:       $LATEST_APPVER"
log "  folder-appears delta:       ${FOLDER_DELTA:-NEVER}s"
log "  sqlite-mtime delta:         ${MTIME_DELTA:-NEVER}s"
log "  new-row delta:              ${ROW_DELTA:-NEVER}s"
log "  row-completed delta:        ${DONE_DELTA:-NEVER}s"
log "  pre-done BUSY rate:         $PRE_DONE_BUSY / $PRE_DONE_PROBES"
log "  post-done burst BUSY rate:  $BURST_BUSY / 20"
log "  bug confirmed:              $(if [[ "$ROW_IN_ARCHIVE" == "0" ]]; then echo YES; else echo NO; fi)"
log "  post-patch datetime stable: $(if [[ "$RECHECK_DT" == "$FAKE_DATETIME" ]]; then echo YES; else echo NO; fi)"
log "==============================================================="
log "log: $LOG"
