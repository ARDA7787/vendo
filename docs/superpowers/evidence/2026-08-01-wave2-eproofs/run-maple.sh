#!/bin/bash
# Wave-2 live E-proofs: ONE Maple dev server, in THIS worktree.
#
#   HARNESS=vendo | instant | claude-code | claude-code-local
#       → MAPLE_HARNESS, read by apps/demo-bank/src/vendo/proof-harness.ts.
#         `vendo` leaves the slot UNSET, which since the wave-2 flip is the
#         composed default `vendo()` serving the chat route.
#   MAPLE_STORE=local  → PGlite at apps/demo-bank/.vendo/data. A harness turn
#         needs the transcript + workspace TABLES, and the SAME dataDir across
#         restarts is what makes the mid-conversation harness swap provable.
#   DEMO_AUTOLOGIN=1   → signed in as the seeded Maple user on first load.
#
# Ports: 3210/3211 = wave-1 rig, 3220-3222 = lane F. This uses 3230.
set -euo pipefail
ROOT=/Users/yousefh/orca/workspaces/flowlet/format
PORT="${PORT:-3230}"
HARNESS="${HARNESS:-vendo}"

set -a
# shellcheck disable=SC1091
. /Users/yousefh/orca/workspaces/flowlet/.env
set +a

[ "$HARNESS" = "vendo" ] || export MAPLE_HARNESS="$HARNESS"
export MAPLE_STORE=local
export DEMO_AUTOLOGIN=1
export AUTH_SECRET="${AUTH_SECRET:-maple-wave2-eproofs-secret}"
export VENDO_BASE_URL="http://127.0.0.1:${PORT}"
export NEXT_TELEMETRY_DISABLED=1
export MAPLE_DIST_DIR="${MAPLE_DIST_DIR:-.next/wave2-eproofs-$PORT}"
# The re-baked e2b template carrying the new wire + the Agent SDK.
export VENDO_BOX_TEMPLATE="${VENDO_BOX_TEMPLATE:-yxxjf7qc038ce899lrhd}"
# A box-side agent build runs for minutes; the provider default 5-minute TTL
# kills it mid-turn (selectSandbox raises the machine lifetime to match).
export VENDO_BOX_EDIT_TIMEOUT_MS="${VENDO_BOX_EDIT_TIMEOUT_MS:-600000}"
export VENDO_EXPERIMENTAL_MACHINES=1
# Lets the proof drive `POST /api/vendo/tick` — the only firing surface the wire
# exposes for schedule automations (wire/misc.ts systemRoutes).
export VENDO_TICK_SECRET="${VENDO_TICK_SECRET:-wave2-eproofs-tick}"
unset NODE_ENV

cd "$ROOT/apps/demo-bank"
exec ./node_modules/.bin/next dev -p "$PORT"
