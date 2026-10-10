#!/usr/bin/env bash
# ============================================================
# run-suite-verified.sh — run the suite and FAIL if a test file went missing.
#
# WHY: measured 2026-10-10 in this environment, `npx vitest run` is
# NON-DETERMINISTIC — it can silently omit an entire test file and still report
# "all passed":
#
#   run1  48 files / 793 tests  passed
#   run2  48 files / 793 tests  passed
#   run3  47 files / 772 tests  passed   <- tests/engines/startpage.test.ts absent
#   (an earlier run: 47 files / 781 tests)
#
# Root cause is environmental, not a repo defect: the system temp directory
# rejects vitest's worker-RPC writes (`EPERM ... \Temp\<rand>\web\<hash>`), and a
# lost RPC result loses a file. Redirecting TEMP/TMP/TMPDIR into the workspace
# removed it: 3/3 runs at a stable 48 files / 793 tests.
#
# A suite that can silently shrink is a FALSE-GREEN gate, which is the exact
# failure mode this repo's own history warns about. So: count the files on disk
# and compare. Do NOT hardcode 793 — the count must come from the tree, or it
# rots the first time a test is added.
# ============================================================
set -u
cd "$(dirname "$0")/../.." || exit 1

EXPECTED=$(ls tests/*.test.ts tests/*/*.test.ts 2>/dev/null | wc -l | tr -d ' ')

# RETRY, don't trust. The drop is intermittent (~1 run in 3, measured), so a
# single run cannot be believed either way — a clean run may be luck and a short
# run may be transient. Retry until the file count matches, and only fail if it
# never does. This makes the gate honest AND usable.
ATTEMPTS=4
rc=1
for attempt in $(seq 1 $ATTEMPTS); do
  OUT=$(npx vitest run 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  FILES=$(echo "$OUT" | grep -oE "Test Files +[0-9]+" | grep -oE "[0-9]+" | head -1)
  TESTS=$(echo "$OUT" | grep -oE "Tests +[0-9]+ (passed|failed)" | grep -oE "[0-9]+" | head -1)
  FAILED=$(echo "$OUT" | grep -cE "^ *FAIL ")

  echo "--- attempt $attempt/$ATTEMPTS ---"
  echo "$OUT" | grep -E "Test Files +[0-9]|Tests +[0-9]" | tr -s ' '

  if [ "${FAILED:-1}" != "0" ]; then
    echo "FAIL: $FAILED test(s) failed. Not retrying a real failure."
    echo "$OUT" | grep -E "^ *FAIL " | head -20
    exit 1
  fi
  if [ "${FILES:-0}" = "$EXPECTED" ]; then
    echo "OK: all $EXPECTED test files ran ($TESTS tests), 0 failures."
    exit 0
  fi
  echo "WARN: only ${FILES:-0} of $EXPECTED files ran — a file was silently dropped. Retrying."
  rc=1
done

echo "FAIL: after $ATTEMPTS attempts the suite still never ran all $EXPECTED files."
echo "      The totals cannot be trusted. Run: npx vitest run --no-file-parallelism"
exit "$rc"
