# Lane E — `claudeCode()` (wave 2)

**Read first, in order** (all paths from repo root):
1. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md` —
   §3 (harness, the claudeCode() settled paragraph, state, mirroring), §4
   (hands table), §8 (workspace), §9 (sandboxes)
2. `docs/superpowers/specs/2026-07-30-build-contract.md` — §1 (FROZEN contract
   you implement against), §3 (workspace paths + materialization §3.5), §8
   (wave cuts; THE LAW's presence predicate)
3. This file.

**The one rule:** we own state, tools, checks, guard, skills; the harness owns
thinking — and orchestration is thinking. If a frozen shape seems wrong, ask
the orchestrator; never diverge locally.

## Mission

The flagship proof that "who thinks" is swappable: `claudeCode()` — the Claude
Agent SDK running in a sandbox, with real bash hands over a materialized
workspace copy — behind the exact same contract `vendo()` already satisfies.
The harness runtime (`@vendoai/harnesses`) already owns guard/audit/mirroring/
transcript/render: you plug into it, you reimplement nothing of the safety
story.

## Ground truth (mapped 2026-08-01; trust it, verify only what you touch)

- Runtime: `packages/harnesses/src/runtime.ts` (Turn at :326, routing :354,
  mirroring via turn-tools). `defineHarness` = `src/define.ts`. Boot gate
  `assertHarnessComposable` = `src/compose.ts` — **its test fixture is already
  `name: "claude-code", requires: {sandbox: true}`**.
- Sandbox seam EXISTS: `packages/apps/src/sandbox.ts` (`SandboxAdapter`
  create/resume/destroy, `SandboxMachine` with `request()`/`snapshot()`),
  `e2bSandbox()` in `packages/apps/src/e2b/`, `cloudSandbox()` in
  `packages/vendo/src/sandbox.ts`; `createVendo({sandbox})` wired at
  `server.ts:342` → `selectSandbox` :629 → compose check :2194. Today's
  lifecycle (`machine-lifecycle.ts`) is APP-scoped; a session-scoped machine
  (one per thread, reused across turns, idle-TTL) has no owner — you build it.
- Box precedent: `packages/apps/box/` — `harness.mjs` (supervisor, control
  port 8811), `agent-sdk.mjs` (SDK `query()` loop, in-process
  `createSdkMcpServer`), `build-template.mjs` (e2b image bake, SDK pinned).
  Host side `box-agent.ts`, `box-env.ts`. Nearest confined-SDK prior art:
  `packages/engine/src/sdk-seam.ts` (`canUseTool` verdicts,
  `permissionMode:"default"`).
- Workspace façade: `packages/store/src/workspace-fs.ts` (staging,
  `commit()` :442), door `workspace.ts:32`. Render seam
  `packages/harnesses/src/render-seam.ts` wraps ONLY `commit` — its header
  comment (:14-19) pre-declares your sync-back: land bytes, call `commit()`,
  views come free.
- MCP door replay-id cache precedent: `packages/mcp/src/door.ts` `#replayId`
  :607 (⚠️ file greps as binary — use `grep -a`).
- TurnState is MEMORY-ONLY today (`memoryHarnessStateStore`,
  `harness-turn.ts:126` hoists one instance). No table exists for it.
- SDK dependency today: `packages/engine` (0.3.214) and the box image
  (0.3.215 via `build-template.mjs`). NOT in `packages/harnesses`.

## Build list

1. **`@vendoai/harnesses/claude-code` subpath** — `claudeCode(options)`
   returning `defineHarness({...})`. Thin: the ~250MB SDK never enters the
   host's node_modules on the sandbox path. Add the `./claude-code` export and
   `peerDependenciesMeta` (SDK optional) to `packages/harnesses/package.json`
   — copy the `packages/apps` pattern (`./e2b`, optional peer).
   v1 options exactly: `model`, `effort`, `maxTurns`, `machine: "local"` —
   nothing else until asked. `requires: {sandbox: true}` unless
   `machine:"local"` (the factory reads its own arg; compose gate stays dumb).
2. **Session-scoped machine acquire** — one `SandboxMachine` per thread,
   acquired on first turn, reused across turns, idle-TTL disposed; built ON
   the existing `SandboxAdapter` (create/resume/destroy + snapshot), never a
   new adapter interface. Holding NO machine lease while an approval waits
   (contract §1.4) — release or let the call proceed leaseless; document what
   you do.
3. **Materialization + diff sync-back** (contract §3.5, verbatim law):
   checkout writes the caller's visible files to the box disk (`/host` mounts
   read-only); sync-back is diff-based per file (content hash), never
   wholesale; `/user/scratch/**` never syncs; hot paths `app.vendo` +
   `plan.vendo` sync MID-TURN (land bytes + `commit()` — the render seam does
   the rest); everything else at turn end. **Checkout/commit permission checks
   live behind ONE seam function** implementing exactly wave-1's rule
   (`/user/**` belongs to its subject, `/host/**` read-only) — wave 3 repoints
   that one function at `can()`; write it so that repoint is a one-line diff.
   Reusable shape (future `codex()`): put materialization in
   `packages/harnesses/src/materialize.ts`, not inside the claude-code
   subpath.
4. **In-process MCP projection of the guarded toolset** — inside the box, the
   runner projects `turn.tools.list()` (names, titles, descriptions,
   inputSchema) as an SDK MCP server; every handler round-trips the bridge to
   the host where **`turn.tools.call()` executes — one guard, one audit row,
   one mirror, exactly like vendo()**. No tool executes box-side. Extend the
   box runner (`packages/apps/box/`) rather than inventing a second
   supervisor; new image layer via `build-template.mjs` if needed.
5. **Guard asks through the native permission hook** — the box is auto-allow
   for its own file/bash work (the box IS the permission: copies only, no
   credentials); projected vendo tools surface guard asks through the SDK's
   permission flow (`canUseTool`), so the co-trained pause-and-explain serves
   our approval cards. Approval semantics are the runtime's (§1.4): you never
   build cards, you deliver the ask and honor the outcome. Ensure a denied /
   timed-out ask reads to the model as a denial it can narrate, not a crash.
6. **Session file + native rewind** — `turn.state` carries the opaque native
   session ref; the session artifact is re-materialized on acquire so an
   idle-TTL'd box never costs a re-seed. Make harness state DURABLE: a
   store-backed implementation of the existing `HarnessStateStore` interface
   (new file in `packages/store/`, style of `workspaceStore`), wired in
   `packages/vendo/src/harness-turn.ts` in place of the memory instance.
   **HARD CONSTRAINT: no new table, no SCHEMA_VERSION bump** (wave-3
   coordination promise) — use the existing `vendo_state` helper
   (`helpers/state.ts`) and/or blobs for large session files; if you truly
   cannot, STOP and ask the orchestrator. Prefix truncation uses the SDK's
   native rewind; arbitrary edits / harness swap → runtime already clears
   state (`classifyHistory` — consume, don't rebuild).
7. **`machine: "local"`** — explicit opt-in that runs the SDK on the host's
   own server: dynamic `import()` (sdk-seam.ts pattern; optional peer),
   workspace materialized to a temp dir, same sync-back seam, no sandbox
   required. Never the default.
8. **Credential law** — the box holds a workspace copy and a turn-scoped
   bridge token, nothing else. No model key in the box beyond the recorded v0
   inference exception (design §9); E7 checks an env dump.

## Frozen shapes you consume (ask, never diverge)

Contract §1 whole (you are a `Harness`; events text/status/error/usage ONLY —
the runtime mirrors tool calls, you never yield them) · §1.4 approvals ·
§3.1 path layout · §3.5 materialization law · THE LAW's presence predicate
(§8 clarifications — presence, never venue) · `WorkspaceFs`/`FilesAdapter`
(core) · `SandboxAdapter`/`SandboxMachine` (apps) — extend behind, never
reshape.

## Acceptance (proven by running the real thing; #631 note below)

- **E1, claudeCode column**: the five asks (normal app · edit-in-place ·
  automation · connector action · impossible ask) run on `claudeCode()`
  against a real e2b sandbox with live keys (canonical key file =
  `flowlet/.env`). Known engine issue #631 makes NEW-app generation fail on
  strict catalogs — NOT yours to fix: run app asks against the seeded demo
  apps. Mid-conversation swap vendo()→claudeCode() continues the thread from
  our transcript.
- **E3 slices**: same app edited by `vendo()` (façade tools) and
  `claudeCode()` (real bash in the box) → byte-identical stored result. Kill
  the sandbox mid-turn → store unchanged, next turn recovers on a fresh
  machine. Skeleton renders mid-turn from a box-side plan write.
- **E6**: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green from
  repo root (`pnpm build` BEFORE any test run — stale dist lies; full suite
  `--force --concurrency=1`; scoped `pnpm --filter <pkg> test`).
- **E7 slices**: sandbox env dump shows no credential beyond the recorded v0
  exception · audit ⊇ transcript holds on a claudeCode run
  (`audit-superset.e2e.test.ts` is the bar) · a guarded call approved via the
  permission hook produces the SAME audit shape as the vendo() path.
- Every boot gate you add ships a test that proves it can still FAIL
  (wave-1 law).

## Out of scope

`instant()` and all config consolidation (lane F) · `codex()` and any second
spawned harness · steering · `/orgs` mounts and real `can()` (wave 3 — you
leave the one seam function) · fixing #631 / quota misclassification /
vendoModel modelId (documented engine follow-ups) · npm publishing mechanics
(changesets — lane F/orchestrator) · new tables or schema bumps · anything in
contract §8's cut list.

## Files you own

- `packages/harnesses/src/claude-code/**` (new) · `src/materialize.ts` (new)
- `packages/harnesses/package.json` (exports + peer meta)
- `packages/apps/box/**` (runner + template extensions)
- `packages/store/src/harness-state*.ts` (new, store-backed HarnessStateStore)
- `packages/vendo/src/harness-turn.ts` (durable-state + materialization wiring)

**Shared, coordinate with orchestrator before non-trivial edits:**
`packages/harnesses/src/index.ts` (append-only), `packages/vendo/src/server.ts`
(lane F owns it this wave — ASK before touching), `packages/apps/src/sandbox.ts`
(shape changes = seam question).

## Discipline

One worktree, space-free path, this lane only. Base = the rebuild/cutover head
your dispatch names. Seam questions → orchestrator; never diverge locally.
Local decisions not covered above: make them, note every one in your lane
report. Report the moment you finish. Never claim done without acceptance
evidence — done = a real path exercises it; correct-but-caller-less code is
wave-1's biggest failure signal.
