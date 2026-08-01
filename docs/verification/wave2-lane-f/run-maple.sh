#!/bin/bash
# Wave-2 lane F live proof: Maple, in THIS worktree.
#
#   MAPLE_HARNESS=instant → `harness: instant()` in createVendo (server.ts).
#                           Unset → the composed `vendo()`, which since the
#                           wave-2 flip is what the chat route runs anyway.
#   MAPLE_STORE=local     → PGlite. Required: a harness turn needs the
#                           transcript + workspace TABLES (§3.3/§6).
#   DEMO_AUTOLOGIN=1      → signed in as the seeded Maple user on first load.
#
# Ports 3210/3211 belong to the wave-1 rig; this uses 3220 (instant) / 3221
# (default vendo()).
set -euo pipefail
ROOT=/Users/yousefh/orca/workspaces/flowlet/wave2-lane-f
PORT="${PORT:-3220}"

set -a
# shellcheck disable=SC1091
. /Users/yousefh/orca/workspaces/flowlet/.env
set +a

export MAPLE_STORE=local
export DEMO_AUTOLOGIN=1
export AUTH_SECRET="${AUTH_SECRET:-maple-wave2-lanef-proof-secret}"
export VENDO_BASE_URL="http://127.0.0.1:${PORT}"
export NEXT_TELEMETRY_DISABLED=1
export MAPLE_DIST_DIR="${MAPLE_DIST_DIR:-.next/wave2-lanef-$PORT}"
unset NODE_ENV

cd "$ROOT/apps/demo-bank"
exec ./node_modules/.bin/next dev -p "$PORT"
