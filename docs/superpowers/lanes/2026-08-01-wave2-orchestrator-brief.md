# Wave-2 orchestrator brief (handoff from the wave-1 session, 2026-08-01)

You are the orchestrator for wave 2 of the embedded-agent rebuild. Wave 1 is
closed: built, integrated, independently checked, live-proven.

## Read first, in order

1. `docs/superpowers/specs/2026-07-30-build-contract.md` — FROZEN. The wave-1
   orchestrator owned it; you inherit that ownership. Lanes ask YOU for
   amendments; they never diverge locally.
2. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md`
3. `docs/superpowers/specs/2026-07-30-implementation-and-evaluation-plan.md`
   — §3 is your wave: Lane E `claudeCode()`, Lane F `instant()` + surface.
   Proof bar: E1 (the headline harness-swap test), E3, E6, E7.
4. Memory notes `vendo-rebuild-wave1-build` (amendment log, rulings,
   environment gotchas — all proven, don't re-derive) and
   `vendo-embedded-agent-architecture` (what was cut and why).

## Ground rules (Yousef's, standing)

- Worktree for integration: `/Users/yousefh/orca/workspaces/flowlet/format`,
  branch `rebuild/cutover`. Builders get their own worktrees (paths WITHOUT
  spaces — a space breaks 7 tests via undecoded %20).
- NEVER push, PR, or merge to main. Local land on `rebuild/cutover` only.
- Factory discipline: lane contracts → parallel factory-builder subagents →
  independent adversarial verification per lane (fresh agent, fix rounds
  until clean) → integrate → wave-level independent check → simplify pass.
- Done = proven by running the real thing. Never grade your own homework.
- Settled decisions are settled: run_code/serve cut; automations never do
  destructive/external actions (prepare-then-human-sends); park is dead for
  new surfaces; no auto-namespacing; presence (never venue) is THE LAW's
  predicate. Don't re-litigate.
- `pnpm build` before ANY test run (stale dist lies). Full suite:
  `pnpm test --force --concurrency=1` from repo root only. Scoped runs:
  `pnpm --filter <pkg> test`. Never `npx vitest --root`.
- dcg guard matches literal command text: prefer file tools over shell for
  edits/reverts, or the founder gets permission popups.

## Wave-2 specific notes from wave 1

- The harness runtime (`@vendoai/harnesses`) already owns guard/audit/
  mirroring/transcript — `claudeCode()` plugs into that, it does not
  reimplement safety.
- `Turn.system` rides the turn; `TurnState` = opaque native session ref.
- Lane E's guard asks go through the Claude Code SDK's native permission
  hook; the box is auto-allow inside, guard decides outside.
- Known open engine issue (NOT yours to fix, don't get dragged in): #631
  dialect gap makes new-app generation fail ~100% against Maple's strict
  catalog; diagnosis in memory note `vendo-rebuild-wave1-build`. Wave-2's
  E-proofs that need a generated app should reuse the seeded demo apps.
- Quota misclassification, silent-empty-descriptors, and the vendoModel
  modelId blind spot are documented in the same memory note (fixes described,
  not applied — an engine follow-up lane, not wave 2).

## Working with Yousef

Report like to a CEO. Facts and bugs are yours; product decisions are his,
one plain-text question at a time with a recommendation. He catches
over-engineering fast — lead with the simplest shape.
