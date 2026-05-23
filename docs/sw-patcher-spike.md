# SuperWhisper Patcher Spike — Findings

> Plan reference: `meeting_capture_pipeline_b3e1ecc8.plan.md`, section
> "Spike — Prove the SW patcher loop end-to-end" (lines 93–118).
>
> Reproduction script: `scripts/spike-sw-patcher.sh` — re-runnable on
> future SuperWhisper upgrades. Live log lives at
> `/tmp/spike-sw-patcher.log` (overwritten on each run).
>
> Verdict: **yellow flag** — Phase 1 is still on the right path, but the
> proposed `waitForCompletion` SQL gate fires too early and SW's
> post-processing then clobbers our patch. See "Required design changes"
> below. The §1.1 bulk-ingest bug is confirmed empirically (and silently
> made worse by swrag's mtime fast-path).

## TL;DR — what worked, what didn't

| Step | Outcome |
| --- | --- |
| 1. Schema snapshot | OK — 19-column schema captured, no surprises vs `src/ingest/sources.ts` notes. |
| 2. `open -a superwhisper /tmp/spike.wav` | OK — SW picked up the file and started processing. |
| 3. Watch folder + DB + row | OK — folder, mtime, row all appear within ~0.8 s of `open`. |
| 3b. Completion gate (the plan's query) | **Fires too early** — gate hits at +12 s, but SW LLM step runs for another ~10 s and **rewrites `datetime`** at the end. |
| 4. Write-lock contention | OK — **zero** `SQLITE_BUSY` in 20 rapid noop UPDATEs and 1 in-flight probe; `busy_timeout=5000` is sufficient (probably unnecessary in single-writer scenarios but cheap to set). |
| 5. Patch DB datetime + meta.json | OK mechanically — UPDATE succeeded, atomic meta.json rewrite succeeded; **but** when applied before SW finished its LLM pass, SW silently overwrote the DB datetime ~10 s later. A re-patch **after** SW is fully done sticks. |
| 6. Re-run `swrag index` to confirm §1.1 | The bug **did not surface in the obvious way** because SW had already moved the datetime forward by the time `swrag index` ran. Confirmed instead by a direct SQL simulation against the spike row after a post-completion re-patch — `WHERE r.datetime > last_indexed_datetime` returns zero rows. **Bug confirmed.** |

## Test environment

- macOS, single-user machine.
- SuperWhisper `appVersion = 2.14.0` (also seen in distribution: 2.13.2 = 298 rows, 2.14.0 = 361 rows over the last 30 days).
- SW SQLite journal mode: `delete` (rollback-journal, **not** WAL — implications noted below).
- SW DB: `~/Library/Application Support/superwhisper/database/superwhisper.sqlite`.
- SW recordings: `~/Documents/superwhisper/recordings/`.
- Test wav: `~/Documents/superwhisper/recordings/1779206778/output.wav` (18 min 18 s, real meeting content).
- SW's currently-selected mode at spike time: **Universal** (key `speech to text`). The mode pipeline this user has configured for that mode happens to include an LLM cleanup step (`languageModelProcessingTime` ≈ 10 s); transcription itself was Scribe Cloud (`processingTime = 0`). The mode-with-LLM-step pattern matters for the "fires too early" finding — see below.
- Spike test row: **`folderName = 1779411490`**.
  - SW DB datetime currently patched to `2026-05-21 01:01:15.000`. Restore via SW's UI or by `UPDATE recording SET datetime = '<original ISO>' WHERE folderName = '1779411490';` (original was `2026-05-22 00:58:33.114`).
  - swrag archive datetime is **stale** at `2026-05-22 00:58:33.114` (last value SW had before the post-spike re-patch).

## 1. `recording` table schema — `TESTED_SW_SCHEMA`

Verified on SW 2.14.0. Use this as the constant in `src/meeting/patcher.ts`:

```
id                          TEXT     PK
datetime                    DATETIME NOT NULL          ← we write this
duration                    DOUBLE   NOT NULL          ← survives reprocessing
appVersion                  TEXT     NOT NULL          ← gate against TESTED_SW_VERSIONS
modelKey                    TEXT     NOT NULL
modelName                   TEXT     NOT NULL
languageModelName           TEXT     NOT NULL
recordingDevice             TEXT     NOT NULL
rawWordCount                INTEGER  NOT NULL
llmWordCount                INTEGER  NOT NULL
prompt                      TEXT     NOT NULL          ← populated only after LLM step
processingTime              INTEGER  NOT NULL          ← 0 for cloud ASR; not a completion signal
languageModelProcessingTime INTEGER  NOT NULL          ← 0 if mode has no LLM, >0 after LLM done
modeName                    TEXT     NOT NULL
promptContext               TEXT     NOT NULL          ← JSON
folderName                  TEXT     NOT NULL          ← join key for the patcher
fromFile                    BOOLEAN  NOT NULL DEFAULT 0 ← `open -a superwhisper file.wav` sets this to 1
createdAt                   DATETIME NOT NULL DEFAULT '2026-02-02 16:20:39.413'
languageModelKey            TEXT     NOT NULL DEFAULT ''
```

`recording_fts(recordingId, llmResult, rawResult, result)` — virtual FTS5 table; `result` is the final (LLM-cleaned-up if applicable) text that ends up in SW's UI.

`fromFile = 1` is a useful disambiguator: any recording produced by our `open -a superwhisper <wav>` path is `fromFile = 1`, so the `waitForCompletion` query can add `AND r.fromFile = 1` to avoid race conditions with user-driven recordings.

### `TESTED_SW_VERSIONS`

```
["2.13.2", "2.14.0"]
```

(2.13.2 is the previous version still present in the row history; 2.14.0 is the active version under which this spike ran.)

## 2 & 3. Timing observations

All deltas are vs `T0` = `open -a superwhisper <wav>` invocation. The test wav was 18 min 18 s of meeting audio, processed via Scribe Cloud + a Meeting-style LLM cleanup prompt.

| Event | Delta | Notes |
| --- | --- | --- |
| New recordings folder appears on disk | **0.80 s** | SW creates `<unix-ts>/` immediately on `open`. |
| SW SQLite mtime first moves | **0.80 s** | Same tick as folder creation — SW inserts the row right away. |
| New row appears in `recording` table (with `datetime > snapshot_max`) | **0.80 s** | Same tick. |
| Row has `processingTime IS NOT NULL AND length(fts.rawResult) > 0` (the plan's gate) | **12.29 s** | Scribe Cloud round-trip + initial row write. |
| **`languageModelProcessingTime > 0` and `length(prompt) > 0`** | **~22 s** (inferred) | LLM step took 10.27 s after the rawResult signal fired. **`datetime` got rewritten at the end of this step**, replacing our patched value. |
| Final mtime quiescence | ~22 s | No further file writes observed after the LLM step settled. |

**Polling cadence**: the script polls every 200 ms via `stat -f %m` and SQL. `fswatch` was not installed; production code should use FSEvents (`fs.watch` recursive) per the plan.

## 4. Write-lock contention

| Probe | `SQLITE_BUSY` rate |
| --- | --- |
| 1 in-flight probe **while SW was still transcribing** (between row-appearance and Scribe completion) | 0 / 1 |
| Single noop UPDATE **without** `busy_timeout` immediately after Scribe completion | 0 / 1 (succeeded clean) |
| Single noop UPDATE **with** `busy_timeout=5000` post-completion | 0 / 1 (succeeded clean) |
| SAVEPOINT + UPDATE + ROLLBACK roundtrip | OK; rollback restored the pre-savepoint datetime |
| Burst: 20 rapid noop UPDATEs post-completion | 0 / 20 |

Observations:

- **`SQLITE_BUSY` was never observed.** SW's SQLite is in rollback-journal mode (`PRAGMA journal_mode = delete`), no WAL sidecar files. Concurrent reader+writer access from sqlite3 CLI worked uneventfully throughout the spike.
- The `5000` strings in the script log are the **return value of `PRAGMA busy_timeout=5000`** (sqlite3 echoes the new timeout), not error messages — confirmed by exit code 0 and a clean burst run. The script's BUSY-detection regex (`/busy|lock/i`) correctly ignores them.
- **Recommendation**: still set `PRAGMA busy_timeout = 5000` defensively. SW likely uses sub-second transactions and we land outside its lock window in practice, but a future SW version could change that.
- **Recommendation**: skip the one-retry-on-BUSY logic for now (the plan calls for it); it adds complexity for a code path the spike couldn't even trigger. If a future spike re-run on a new SW version observes BUSY, add the retry then.

## 5. Patch results

- `UPDATE recording SET datetime = ? WHERE folderName = ?` — works.
- `<folder>/meta.json` atomic rewrite via temp + `rename` — works; `Bun.file` will do this nicely in production.
- **Post-completion stability**: a re-patch performed **after** all SW post-processing finished was still in place 5 s later (verified by a second SELECT). The patch is durable as long as we wait long enough.

### The structural surprise

The patch applied **during** SW's LLM step was silently overwritten. Timeline of the spike's main run:

1. `T0`: `open -a superwhisper`.
2. `T0 + 0.8 s`: row + folder appear, `datetime = "2026-05-22 00:58:22.812"`.
3. `T0 + 12.3 s`: Scribe transcription completes, `rawResult` populated, `processingTime IS NOT NULL`. **Plan's `waitForCompletion` gate would fire here.**
4. `T0 + ~12.5 s`: script patches `datetime` to `"2026-05-21 00:58:27.000"`. Verifies it stuck at `T0 + 13.5 s`.
5. `T0 + ~22 s`: SW LLM step finishes. SW UPDATEs the row: writes `prompt`, `llmResult`, `result`, sets `languageModelProcessingTime`, **and rewrites `datetime` to `"2026-05-22 00:58:33.114"`** (current time at LLM-done).
6. `T0 + ~24 s`: `swrag index` runs, sees the row with the *clobbered* datetime, ingests it as new (because that datetime > `last_indexed_datetime`).

So the spike's pass through Step 6 happened with a row whose patch had already been wiped — which is why the "expected" §1.1 silent-drop didn't appear directly. The bug is still real (see Step 6 below).

## 6. Confirmation of the §1.1 bulk-ingest bug

After SW had fully finished all post-processing (`languageModelProcessingTime > 0`, no more file mtime activity), the spike re-patched `datetime` to `2026-05-21 01:01:15.000` and verified it stuck for 5 s.

Direct SQL simulation against SW's DB using the bulk ingester's actual WHERE clause:

```sql
-- last_indexed_datetime = '2026-05-22 00:58:33.114' (current swrag value)
SELECT folderName, datetime
FROM recording
WHERE datetime > '2026-05-22 00:58:33.114'
  AND folderName = '1779411490';
-- → 0 rows
```

Versus a targeted lookup (the Phase 1 `runIndexFolder` approach):

```sql
SELECT folderName, datetime FROM recording WHERE folderName = '1779411490';
-- → 1 row: ('1779411490', '2026-05-21 01:01:15.000')
```

**§1.1 confirmed.** Any row whose `datetime` we patch into the past is invisible to the bulk-ingest SELECT and will never reach swrag's archive via that path. Phase 1's `runIndexFolder({ folderName })` is required.

### A *second*, related bug worth flagging

`runSql` (every `swrag sql` invocation) calls `ensureFresh`, which calls the slow path when the source mtime moves. The slow path stores `source_mtime_ns` even when it found 0 new rows. So:

1. We patch `datetime` to the past. File mtime bumps.
2. The next innocuous `swrag sql …` triggers `ensureFresh` → slow path → 0 rows found (because of §1.1) → **stores the new `source_mtime_ns` anyway**.
3. A subsequent `swrag index` short-circuits with `"source unchanged; nothing to do"`, never giving the bulk path another shot.

In other words, the §1.1 silent drop is *also* protected against retry by the mtime fast-path. Observed empirically in this spike: my follow-up `swrag index` reported `source unchanged` even though the patched row was demonstrably missing from the archive. Phase 1's `runIndexFolder` sidesteps this by *not* relying on bulk-ingest at all; no fix to the fast-path is required so long as the patcher always pairs with a targeted index call.

## Required Phase 1 design changes

Phase 1's plan stands in shape but needs three concrete adjustments:

### 1. The `waitForCompletion` SQL gate is wrong as currently written

The plan's query gates on:

```sql
r.processingTime IS NOT NULL AND length(fts.rawResult) > 0
```

That fires after the **ASR** step, not after the **LLM** step. If the active SW mode has any LLM cleanup configured (Universal, Meeting, and most custom modes in practice), SW will rewrite the row — including `datetime` — at LLM-done time, *after* our patcher has run. Our patched `datetime` gets silently wiped.

Replace the gate with a quiescence-based signal:

```ts
// 1. Identify the candidate row as soon as it appears.
const ROW_APPEARS = `
  SELECT id, folderName FROM recording
  WHERE datetime > ?              -- cutoffIso
    AND fromFile = 1              -- only ours
    AND ABS(duration - ?) < 50    -- durationMs match
  ORDER BY datetime DESC LIMIT 1
`;

// 2. Once we have the row, wait for SW to stop writing it.
//    Either: poll/watch SW DB mtime and require N seconds of stability,
//    OR: require length(fts.result) > 0 AND no further mtime change
//        for a short quiescence window (1–2 s).
```

Concretely:

- The completion **trigger** (when to start patching) should be:
  `length(fts.result) > 0` (the final post-LLM text is non-empty)
  **AND** SW's DB file mtime has not advanced for ≥ 2 s.
- We must hold the watcher open until both conditions are simultaneously true.
- This is mode-agnostic — works whether the mode has an LLM step or not.

`fromFile = 1` neatly disambiguates our drop-in wavs from any concurrent user-driven recordings, eliminating the duration-match ambiguity.

### 2. `TESTED_SW_VERSIONS` and `TESTED_SW_SCHEMA` constants

Bake into `src/meeting/patcher.ts`:

```ts
export const TESTED_SW_VERSIONS = ["2.13.2", "2.14.0"] as const;

export const TESTED_SW_SCHEMA = [
  ["id",                          "TEXT"],
  ["datetime",                    "DATETIME"],
  ["duration",                    "DOUBLE"],
  ["appVersion",                  "TEXT"],
  ["modelKey",                    "TEXT"],
  ["modelName",                   "TEXT"],
  ["languageModelName",           "TEXT"],
  ["recordingDevice",             "TEXT"],
  ["rawWordCount",                "INTEGER"],
  ["llmWordCount",                "INTEGER"],
  ["prompt",                      "TEXT"],
  ["processingTime",              "INTEGER"],
  ["languageModelProcessingTime", "INTEGER"],
  ["modeName",                    "TEXT"],
  ["promptContext",               "TEXT"],
  ["folderName",                  "TEXT"],
  ["fromFile",                    "BOOLEAN"],
  ["createdAt",                   "DATETIME"],
  ["languageModelKey",            "TEXT"],
] as const;
```

The schema check should compare names + types case-insensitively; SW has been stable across 2.13 → 2.14.

### 3. Drop the BUSY retry, keep `busy_timeout`

Zero BUSY events observed across 21 probes and a real-world patch. The plan's "one retry on `SQLITE_BUSY`" inside a SAVEPOINT is dead code under current SW. Set `PRAGMA busy_timeout = 5000` and skip the retry. Re-evaluate if a future spike re-run sees BUSY.

## Surprises that did *not* change Phase 1 design

- `processingTime = 0` for Scribe Cloud is **valid, not a sentinel**. `IS NOT NULL` is a useless check on its own.
- `SQLITE_BUSY` never fires under this user's load profile. The plan's defensive copy was right to keep `busy_timeout`, but the SAVEPOINT-and-retry dance is unnecessary today.
- `fromFile` column is set to `1` automatically by `open -a superwhisper`. **Bonus.** Use it as a query disambiguator.
- swrag archive contains the spike row but with the *stale* datetime `2026-05-22 00:58:33.114`. Phase 1's `runIndexFolder` will overwrite this on the first real run, so no cleanup needed in the archive.

## Cleanup / state left behind

- `/tmp/spike-sw-patcher.wav` — deleted by the script.
- `/tmp/spike-sw-patcher.log` — preserved for re-inspection.
- `/tmp/spike-sw-patcher.busy-probe.log` — preserved.
- `/tmp/spike-sw-patcher.folders-before` — preserved.
- SW recordings folder `1779411490/` — **kept on disk** with a patched (24h-past) datetime in both SW's DB and `meta.json`. Restore via the SW app's UI (delete and let SW resync) or by manually re-UPDATEing the row.
- swrag archive row for `1779411490` — present at the stale clobbered datetime. Will be overwritten by Phase 1's first real run, so no action needed now.

## Verdict for Phase 1

**Yellow flag** — proceed to Phase 1 implementation **with the three design changes above baked in**:

1. Quiescence-based `waitForCompletion` gate (not `rawResult IS NOT NULL`), with `fromFile = 1` filter.
2. Bake `TESTED_SW_VERSIONS` and `TESTED_SW_SCHEMA` as documented.
3. Drop the SQLITE_BUSY SAVEPOINT-retry path; keep `busy_timeout = 5000`.

The §1.1 bug is real and `runIndexFolder` remains mandatory. No structural showstoppers — SW's DB is happily writeable and the post-completion patch sticks.
