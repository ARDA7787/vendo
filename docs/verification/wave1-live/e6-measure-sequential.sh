#!/bin/bash
# E6 — MEASURE, don't assert. Same asks, same host, same model, same store,
# ONE path at a time.
#
# Sequential is not a style choice: `MAPLE_STORE=local` resolves `createStore()`
# with the default dataDir `.vendo/data`, PGlite is single-writer, and the first
# attempt at this ran both paths at once — the second server blocked on the
# writer lock and every one of its turns timed out at 5.0 min with the store
# never opening. Concurrent A/B on one PGlite dir cannot produce a latency
# number for either side.
#
# Outcome is read off the SSE, never the status code: `data-vendo-build-failed`
# is a failure at HTTP 200.
set -uo pipefail
ROOT=/Users/yousefh/orca/workspaces/flowlet/format
OUT="$ROOT/docs/verification/wave1-live/test-output"
RESULTS="$OUT/e6-measurements.tsv"
mkdir -p "$OUT"

A1="What is my checking balance right now?"
A2="Which three categories did I spend the most on this month?"
A3="Build me a simple view of my savings balance."

boot() { # mode port
  local mode="$1" port="$2"
  ( set -a; . /Users/yousefh/orca/workspaces/flowlet/.env; set +a
    export MAPLE_STORE=local DEMO_AUTOLOGIN=1
    export AUTH_SECRET="maple-wave1-live-proof-secret"
    export VENDO_BASE_URL="http://127.0.0.1:${port}"
    export NEXT_TELEMETRY_DISABLED=1 MAPLE_DIST_DIR=".next/wave1-${mode}"
    if [ "$mode" = harness ]; then export MAPLE_HARNESS=1; else unset MAPLE_HARNESS; fi
    unset NODE_ENV
    cd "$ROOT/apps/demo-bank"
    exec ./node_modules/.bin/next dev -p "$port"
  ) > "/tmp/e6-${mode}.log" 2>&1 &
  echo $!
  for _ in $(seq 1 60); do
    sleep 2
    curl -s -o /dev/null --max-time 5 "http://127.0.0.1:${port}/" && return 0
  done
  return 1
}

ask() { # port label n text jar
  local port="$1" label="$2" n="$3" text="$4" jar="$5"
  local body sse start end secs http views failed deltas tools
  body=$(python3 -c '
import json,sys
print(json.dumps({"threadId": sys.argv[1], "message":{"id":sys.argv[2],"role":"user","parts":[{"type":"text","text":sys.argv[3]}]}}))
' "thr_e6b_${label}_${n}" "m_${label}_${n}" "$text")
  sse="$OUT/e6b-${label}-ask${n}.sse"
  start=$(python3 -c 'import time;print(time.time())')
  http=$(curl -s -b "$jar" -X POST "http://127.0.0.1:${port}/api/vendo/threads" \
    -H 'content-type: application/json' -d "$body" -o "$sse" -w '%{http_code}' --max-time 240)
  end=$(python3 -c 'import time;print(time.time())')
  secs=$(python3 -c "print(f'{${end}-${start}:.1f}')")
  views=$(grep -c 'data-vendo-view' "$sse" 2>/dev/null | tr -d '\n'); views=${views:-0}
  failed=$(grep -c 'data-vendo-build-failed' "$sse" 2>/dev/null | tr -d '\n'); failed=${failed:-0}
  deltas=$(grep -c 'text-delta' "$sse" 2>/dev/null | tr -d '\n'); deltas=${deltas:-0}
  tools=$(grep -o '"toolName":"[a-z_]*"' "$sse" 2>/dev/null | sed 's/.*://;s/"//g' | sort -u | paste -sd, - )
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$n" "$secs" "$http" "$views" "$failed" "$deltas" "${tools:-none}" >> "$RESULTS"
}

printf 'path\task\tseconds\thttp\tview_parts\tbuild_failed\ttext_deltas\ttools_called\n' > "$RESULTS"

for mode in harness legacy; do
  port=$([ "$mode" = harness ] && echo 3210 || echo 3211)
  pkill -f "next dev -p ${port}" 2>/dev/null; sleep 2
  boot "$mode" "$port" >/dev/null || { echo "$mode failed to boot"; continue; }
  jar="/tmp/e6b-${mode}.txt"
  curl -s -c "$jar" -o /dev/null "http://127.0.0.1:${port}/"
  ask "$port" "$mode" 1a "$A1" "$jar"
  ask "$port" "$mode" 1b "$A1" "$jar"
  ask "$port" "$mode" 2  "$A2" "$jar"
  ask "$port" "$mode" 3  "$A3" "$jar"
  pkill -f "next dev -p ${port}" 2>/dev/null; sleep 3
done

column -t -s $'\t' "$RESULTS"
