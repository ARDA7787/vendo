#!/bin/bash
# Wave-2 lane F: the PERMISSIVE surface. demo-template's catalog is empty, so
# generation can only reach built-in kit components — no host-component props to
# miss, which is engine issue #631's whole trigger. This is where the pipeline's
# own ≤5s skeleton is measurable.
set -euo pipefail
ROOT=/Users/yousefh/orca/workspaces/flowlet/wave2-lane-f
PORT="${PORT:-3222}"
set -a
# shellcheck disable=SC1091
. /Users/yousefh/orca/workspaces/flowlet/.env
set +a
export DEMO_STORE=local
export NEXT_TELEMETRY_DISABLED=1
export VENDO_BASE_URL="http://127.0.0.1:${PORT}"
export DEMO_DIST_DIR="${DEMO_DIST_DIR:-.next/wave2-lanef-$PORT}"
unset NODE_ENV
cd "$ROOT/apps/demo-template"
exec ./node_modules/.bin/next dev -p "$PORT"
