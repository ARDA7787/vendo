#!/bin/bash
# Keeps the proof server up and RECORDS every death with a timestamp.
#
# Why: two `next dev` servers from another session (Keystone, /private/tmp/
# keystone-*) share this machine, and during this run BOTH of my servers — the
# harness one on 3210 AND the untouched legacy one on 3211 — died at the same
# moment with no stack trace, no crash report, and 77% free memory. That is an
# outside reaper, not a Vendo fault. The death log is what tells the two apart:
# a death while the server is IDLE is environmental; a death that only ever
# lands during a turn is ours.
#
# Usage: supervise-maple.sh <harness|legacy> <port>
set -uo pipefail
MODE="${1:-harness}"
PORT="${2:-3210}"
ROOT=/Users/yousefh/orca/workspaces/flowlet/format
DEATHS="$ROOT/docs/verification/wave1-live/server-deaths-${MODE}.log"

while true; do
  echo "[$(date -u +%H:%M:%S)] starting ${MODE} on ${PORT}" >> "$DEATHS"
  (
    set -a
    # shellcheck disable=SC1091
    . /Users/yousefh/orca/workspaces/flowlet/.env
    set +a
    export MAPLE_STORE=local DEMO_AUTOLOGIN=1
    export AUTH_SECRET="maple-wave1-live-proof-secret"
    export VENDO_BASE_URL="http://127.0.0.1:${PORT}"
    export NEXT_TELEMETRY_DISABLED=1
    export MAPLE_DIST_DIR=".next/wave1-${MODE}"
    if [ "$MODE" = "harness" ]; then export MAPLE_HARNESS=1; else unset MAPLE_HARNESS; fi
    unset NODE_ENV
    cd "$ROOT/apps/demo-bank"
    exec ./node_modules/.bin/next dev -p "$PORT"
  )
  echo "[$(date -u +%H:%M:%S)] ${MODE} on ${PORT} EXITED code=$?" >> "$DEATHS"
  sleep 3
done
