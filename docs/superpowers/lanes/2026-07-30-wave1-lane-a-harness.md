# Lane A — harness contract + `vendo()` (wave 1)

**Read first, in order** (all paths from repo root):
1. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md` — §2 (dividing line), §3 (harness + mirroring + voice law), §10 (config)
2. `docs/superpowers/specs/2026-07-30-build-contract.md` — §1 (FROZEN — your entire public surface), §2 (layering), §4 (seats, types only), §6 (the store helper you consume)
3. This file.

**The one rule:** we own state, tools, checks, guard, skills; the harness owns
thinking — and orchestration is thinking. The runtime you build is plumbing,
never a decision-maker. If a shape in the build contract seems wrong, ask the
orchestrator; never diverge locally.

## Mission

Make "who thinks" a swappable adapter. Deliver the frozen `Harness`/`Turn`
contract as core types, the `@vendoai/harnesses` runtime that runs any harness
safely, and `vendo()` — today's `@vendoai/agent` loop re-expressed as the first
harness — with zero change to the wire format hosts already render.

## Build list

1. **Core contract types** — new file `packages/core/src/harness.ts`, type-only:
   `Harness`, `Turn`, `TurnTools`, `ToolResult`, `DeniedNeeds`, `ToolListing`,
   `TurnSkills`, `SkillListing`, `TurnState`, `HarnessEvent` — exactly as build
   contract §1 (copy, don't redesign). `Turn.workspace` is typed against lane
   B's `WorkspaceFs` (core type, `packages/core/src/workspace.ts`); `Turn.models`
   against lane D's `ResolvedModels` seat record (core type). Import the types;
   do not define them.
2. **`defineHarness(def): Harness`** — returns the value itself; host deps by
   plain factory closure, no factory concept in the contract.
3. **The runtime** — new package `packages/harnesses` (`@vendoai/harnesses`):
   - Turn assembly (messages read-only view, tools/skills/workspace/models/
     state/options/signal/interactive).
   - Event routing, frozen table: `text` → screen + transcript · `status` →
     screen only · `error` → screen + transcript + audit · `usage` →
     audit/metering only. Tool calls are mirrored by the runtime, never yielded.
   - Wire output: today's ai-SDK UIMessage stream with the existing
     `data-vendo-*` parts (`packages/core/src/stream-parts.ts` — UNCHANGED; no
     new wire format).
   - **Hot-path render seam** (contract §1.6 — read the full paragraph): every
     store write to `app.vendo`/`plan.vendo` that parses makes the runtime emit
     today's `data-vendo-view` part — same payload (assembled tree), same
     stable per-app stream id, same field stripping, same progressive
     query-resolver fill; the assembly/stripping/resolver code exists in
     `packages/apps` (`runtime.ts` emit path, `agent-tools.ts` onView) and
     relocates behind the runtime. Unparseable write → emit nothing, keep the
     last good view. Harnesses never yield view events.
   - Transcript persistence through the store helper frozen in contract §6
     (`threadMessageStore.upsert/list`) — lane D builds it; code against the
     signature. No `@vendoai/store` import: the store handle arrives as a
     composed value through the umbrella, typed by core seams.
   - `turn.tools.call()` semantics: never throws; guarded, audited, mirrored
     before it resolves; `ToolOutcome` (core `tools.ts`, unchanged) mapped to
     the three-status `ToolResult` per contract §1.1.
   - Approvals per contract §1.4: `interactive === true` → await the tap inside
     `call()` up to `APPROVAL_WAIT_MS = 90_000`, no sandbox lease held;
     `interactive === false` → immediate `denied{needs:approval}`.
   - `turn.state` persistence (opaque string, saved at turn end; cleared on
     arbitrary history edits or harness swap).
4. **`vendo()`** — today's loop in `packages/agent/src/agent.ts` (the
   `streamText` call inside the `createUIMessageStream` closure) lifted onto
   `run(turn)`: same behavior, tools now through `turn.tools`, output as
   `HarnessEvent`s, **plus subagent hiring** (the harness dispatches its own
   native subagents for big jobs, e.g. the app-builder skill's advice; weight
   and staffing are the harness's business).
5. **Boot-time composition errors** — `requires: { sandbox }` checked at
   `createVendo` composition ("X needs a sandbox adapter"), never at runtime.
6. **Layering** — add to `scripts/dependency-guard.mjs` LAYERS exactly:
   `"@vendoai/harnesses": ["@vendoai/core", "@vendoai/agent", "@vendoai/apps", "@vendoai/guard"]`.

## Frozen shapes you consume (canonical = build contract; ask, never diverge)

- §1 whole: `Harness`, `Turn`, events, tool statuses, approval semantics.
- §1.6 routing table + hot-path render seam.
- §4 `Seat` / `ResolvedModels` types (lane D owns the resolution; you consume the type).
- §6 `threadMessageStore` helper signature (lane D builds).
- Core `ToolOutcome` (`packages/core/src/tools.ts`) — unchanged, you map it.
- `WorkspaceFs` type (lane B owns `packages/core/src/workspace.ts`); for your
  tests use just-bash's in-memory filesystem, not a home-rolled stub.

## Acceptance (from plan §6 — proven by running the real thing)

- **E1, wave-1 slice**: the five asks (normal app · edit-in-place · automation
  · connector action · impossible ask) pass on `vendo()` against Yousef's Vendo
  Cloud account in a real browser. (`instant()`/`claudeCode()` columns are
  wave 2; harness-swap mid-conversation is demonstrated by swapping between two
  `vendo()` instances resuming from our transcript.)
- **E2 participation**: the interactive approval block (§1.4) drives the real
  popup flow — approve executes, refuse yields an honest message.
- **E6**: failure rate and latency never worse than today's baseline · real
  layout on screen ≤5s typical · `pnpm build && test && typecheck && lint`
  green · transcript writes O(messages), **measured**, not asserted.

## Out of scope

Steering (mid-turn user input — cut from wave 1) · `claudeCode()` and
`instant()` extraction (wave 2) · config consolidation 29→6 (wave 2, lane F) ·
the workspace implementation (lane B) · pack merge/skills store (lane C) ·
the store migration itself and seat resolution (lane D) · anything in contract
§8's cut list.

## Files you own

- `packages/harnesses/**` (new package)
- `packages/core/src/harness.ts` (new)
- `packages/agent/src/agent.ts` (the lift; keep exports other blocks use)
- `scripts/dependency-guard.mjs` (your one LAYERS row only)

**Shared, append-only, orchestrator merges at land:** `packages/core/src/index.ts`
(your export lines), `packages/vendo/src/server.ts` (composition wiring —
coordinate any non-trivial edit with the orchestrator first).

## Discipline

One worktree, this lane only. Seam questions → orchestrator. Report the moment
you finish. Local decisions not covered above: make them, note every one in
your lane report. Never claim done without the acceptance evidence.
