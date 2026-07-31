#!/bin/bash
# Wave-1 live proof: Maple on the HARNESS path.
#
#   MAPLE_HARNESS=1  → POST /api/vendo/threads is served by the composed
#                      `vendo.harness` door (src/vendo/harness-proof.ts), and the
#                      two canned demo seams are skipped.
#   MAPLE_STORE=local → PGlite. Required: the harness path needs a SQL-backed
#                      store for the transcript + workspace tables (§3.3/§6);
#                      the Cloud hosted store throws "not-implemented".
#   DEMO_AUTOLOGIN=1 → signed in as the primary seeded Maple user on first load.
#
# Ports 3111/3112 belong to another session — this uses 3210 (legacy comparison
# run uses 3211 with MAPLE_HARNESS unset).
set -euo pipefail
ROOT=/Users/yousefh/orca/workspaces/flowlet/format
PORT="${PORT:-3210}"

set -a
# shellcheck disable=SC1091
. /Users/yousefh/orca/workspaces/flowlet/.env
set +a

export MAPLE_STORE=local
export DEMO_AUTOLOGIN=1
export AUTH_SECRET="${AUTH_SECRET:-maple-wave1-live-proof-secret}"
export VENDO_BASE_URL="http://127.0.0.1:${PORT}"
export NEXT_TELEMETRY_DISABLED=1
export MAPLE_DIST_DIR="${MAPLE_DIST_DIR:-.next/wave1-harness}"
unset NODE_ENV

cd "$ROOT/apps/demo-bank"
exec ./node_modules/.bin/next dev -p "$PORT"
