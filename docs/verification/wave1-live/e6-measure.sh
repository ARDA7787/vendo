#!/bin/bash
# E6 — MEASURE, don't assert. The same asks down both paths, same host, same
# model, same store engine: 3210 = harness (`vendo.harness` door), 3211 = legacy
# (`createAgent`). Reports wall time and the outcome of each turn.
#
# Outcome is read off the SSE stream, not the status code: a turn that streams
# `data-vendo-build-failed` is a failure at HTTP 200, and `text-delta` with no
# view part means it answered in prose instead of building.
set -uo pipefail
OUT=/Users/yousefh/orca/workspaces/flowlet/format/docs/verification/wave1-live/test-output
mkdir -p "$OUT"
RESULTS="$OUT/e6-measurements.tsv"
printf 'path\task\tseconds\thttp\tview_parts\tbuild_failed\ttext_deltas\ttool_calls\n' > "$RESULTS"

ask() { # port label cookiejar askno text
  local port="$1" label="$2" jar="$3" n="$4" text="$5"
  local body sse start end secs http
  body=$(python3 -c '
import json,sys
print(json.dumps({"threadId": sys.argv[1], "message": {"id": sys.argv[2], "role":"user","parts":[{"type":"text","text": sys.argv[3]}]}}))
' "thr_e6_${label}_${n}_$RANDOM" "m_${label}_${n}" "$text")
  sse="$OUT/e6-${label}-ask${n}.sse"
  start=$(python3 -c 'import time;print(time.time())')
  http=$(curl -s -b "$jar" -X POST "http://127.0.0.1:${port}/api/vendo/threads" \
    -H 'content-type: application/json' -d "$body" -o "$sse" -w '%{http_code}' --max-time 300)
  end=$(python3 -c 'import time;print(time.time())')
  secs=$(python3 -c "print(f'{${end}-${start}:.1f}')")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$n" "$secs" "$http" \
    "$(grep -c 'data-vendo-view' "$sse" 2>/dev/null || echo 0)" \
    "$(grep -c 'data-vendo-build-failed' "$sse" 2>/dev/null || echo 0)" \
    "$(grep -c 'text-delta' "$sse" 2>/dev/null || echo 0)" \
    "$(grep -o '"toolName":"[a-z_]*"' "$sse" 2>/dev/null | sort -u | tr '\n' ',' || echo none)" \
    >> "$RESULTS"
}

curl -s -c /tmp/e6-h.txt -o /dev/null http://127.0.0.1:3210/
curl -s -c /tmp/e6-l.txt -o /dev/null http://127.0.0.1:3211/

A1="What is my checking balance right now?"
A2="Which three categories did I spend the most on this month?"
A3="Build me a simple view of my savings balance."

for n in 1 2; do
  ask 3210 harness /tmp/e6-h.txt "1r$n" "$A1"
  ask 3211 legacy  /tmp/e6-l.txt "1r$n" "$A1"
done
ask 3210 harness /tmp/e6-h.txt 2 "$A2"
ask 3211 legacy  /tmp/e6-l.txt 2 "$A2"
ask 3210 harness /tmp/e6-h.txt 3 "$A3"
ask 3211 legacy  /tmp/e6-l.txt 3 "$A3"

column -t -s $'\t' "$RESULTS"
