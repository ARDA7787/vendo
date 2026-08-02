#!/bin/bash
# E6 spot confirmation only: demo-template's catalog is EMPTY, so generation can
# only reach built-in kit components — no host-component props to miss, which is
# engine #631's trigger. Lane F measured the instant() median here (6.1s first
# view); this re-measures ONE create to confirm nothing regressed.
#
# Port 3231 (lane F used 3222, the Maple rig above uses 3230).
set -euo pipefail
ROOT=/Users/yousefh/orca/workspaces/flowlet/format
PORT="${PORT:-3231}"
set -a
# shellcheck disable=SC1091
. /Users/yousefh/orca/workspaces/flowlet/.env
set +a
[ "${HARNESS:-instant}" = "vendo" ] || export DEMO_HARNESS="${HARNESS:-instant}"
export DEMO_STORE=local
export NEXT_TELEMETRY_DISABLED=1
export VENDO_BASE_URL="http://127.0.0.1:${PORT}"
export DEMO_DIST_DIR="${DEMO_DIST_DIR:-.next/wave2-eproofs-$PORT}"
unset NODE_ENV
cd "$ROOT/apps/demo-template"
exec ./node_modules/.bin/next dev -p "$PORT"
