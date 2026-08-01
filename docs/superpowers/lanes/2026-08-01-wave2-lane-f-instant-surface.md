# Lane F — `instant()` + the config surface (wave 2)

**Read first, in order** (all paths from repo root):
1. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md` —
   §2 (single model calls survive only as internals — instant()'s guts), §3,
   §6 (instant() = the pattern compiled into a specialist), §10 (the whole
   config surface — your target shape, verbatim)
2. `docs/superpowers/specs/2026-07-30-build-contract.md` — §1 (the contract
   instant() satisfies), §2 (layering), §4 (seats)
3. This file.

**The one rule:** we own state, tools, checks, guard, skills; the harness owns
thinking — and orchestration is thinking. If a frozen shape seems wrong, ask
the orchestrator; never diverge locally.

## Mission

Two halves of one story — the specialist harness and the surface a host meets:
`instant()` (today's non-agentic generation conductor behind the harness
contract, ≤5s skeleton) and the consolidated `createVendo` config (§10's
slots + `packs`, a complete key-migration table, init-first quickstart,
`@vendoai/harnesses` made publishable).

## Ground truth (mapped 2026-08-01; trust it, verify only what you touch)

- The conductor: `packages/apps/src/generation/conductor.ts` (`conductCreate`
  :346, `conductEdit` :397, `FIX_ROUNDS = 2` :50); deps shape
  `GenerationDependencies` at `generation/engine.ts:42-86`; invoked from
  `packages/apps/src/runtime.ts` (:1794 create, :2130 edit); `data-vendo-view`
  minted at `runtime.ts:1742-1767`. NOTE: `packages/engine` is a DIFFERENT
  thing (npx SDK runner, deliberate dependency leaf — never route through it).
- `instant()` / `fastPipeline()` do not exist anywhere — only the docstring
  promise at `packages/harnesses/src/index.ts:9-10`.
- Config: `CreateVendoConfig` at `packages/vendo/src/server.ts:285-550` —
  **33 top-level keys today** (the spec's "29" is stale; the law is the same:
  every key gets a stated destination). No `tools:` slot exists — it's a NEW
  slot, not a rename. Deprecation shims precedent: `model`/`paint` in
  `models-config.ts:85-151`. Adapter-rule reference: `selectConnections`
  `server.ts:811-826` (canonical doc block :776-787).
- Routing split (deliberate wave-1 ruling): `server.ts:2511-2519` — the chat
  route uses the harness runtime ONLY when the host named a harness; default
  still runs `createAgent`. The comment says "flipping it is this one line."
- Two `vendo()` constructions: `server.ts:2193` (compose assert only) and
  `harness-turn.ts:166` (the real default).
- Packs: `DEFAULT_PACKS = [apps()]` at `packages/vendo/src/packs/defaults.ts:10`;
  `apps()` at `packs/apps.ts:37` contributes tools + skills only.
- Publishing: `@vendoai/harnesses` is NOT private, version 0.5.0, npm 404,
  absent from `.changeset/config.json` `fixed[0]` (group is at 0.6.1), absent
  from `PUBLISH.md` — yet `release.yml` (:70/:83/:102) publishes every
  non-private `packages/*` on a v-tag, so today's state would ship an
  unreviewed 0.5.0. A pending changeset exists
  (`.changeset/harness-runtime-and-vendo-harness.md`).
- Docs gate is inert: `handler-options.docs.test.ts` pins 23/33 keys and its
  `AssertNever` never runs (tsconfig excludes tests from typecheck). 10 keys
  undocumented in `docs-site/reference/handler-options.mdx`.
- genui-bench (`apps/genui-bench/lanes/vendo.ts:37-43`) imports
  `conductCreate/ConductorOptions/GenerationDependencies` from
  `@vendoai/apps` — those re-exports must survive.
- Layering: `harnesses → core, agent, apps, guard` already exists
  (dependency-guard :78). `apps → harnesses` is ILLEGAL. So: pipeline body
  stays in `packages/apps` (plain functions), the `Harness` wrap lives in
  `packages/harnesses`. No new guard edge.
- Init CLI: `packages/vendo/src/cli/init.ts` (writes `.vendo/*` — enumerated
  :910-915 — plus the catch-all route with the `createVendo` composition).

## Build list

1. **`instant()`** — `packages/harnesses/src/instant.ts`, exported from the
   root barrel. The specialist: non-agentic, single model calls as internals,
   never a thinking loop. Shape: classify the ask mechanically-or-with-one-call
   (create / edit / neither); app asks run the conductor fast path — one plan
   call, parallel bare fill calls, skeleton on screen ≤5s, internal reviewer
   kept (`FIX_ROUNDS` stays 2); non-app asks get at most one model call over
   the guarded toolset (`turn.tools`) so automations/connector actions still
   work through the same guard door; genuinely-impossible asks refuse honestly
   in consumer voice. All host effects through `turn.tools.call()` — one
   guard, one audit shape, same as every harness. Events: the closed
   vocabulary only; views come from the render seam (land bytes + commit) or
   the existing onView path — you never yield view events.
   Authoring split (layering law): any new pipeline body lives in
   `packages/apps` (plain functions over `GenerationDependencies`); the
   `defineHarness` wrap in `packages/harnesses`. Keep
   `conductCreate`/`conductEdit` re-exported from `@vendoai/apps` — the bench
   depends on them.
   How instant() gets generation deps at boot (host writes `harness:
   instant()` with no context) is YOUR local design problem — the vendo()
   precedent is deps-optional factory + everything else riding the Turn; if
   you need a new Turn field, that is a seam question for the orchestrator,
   never a local addition.
2. **Flip the default route** — `server.ts:2519`: the chat route goes through
   the harness runtime always, default `vendo()`. Gated by the parity oracle
   (`packages/vendo/src/harness-wire.test.ts` rail parity, and
   `packages/harnesses/src/parity.test.ts`) and E6 (failure rate + latency
   never worse than baseline). If parity or baseline breaks and the fix isn't
   obvious, STOP and escalate — do not weaken the oracle. Collapse the
   duplicate `vendo()` construction (server.ts:2193 vs harness-turn.ts:166)
   into one while you're there.
3. **Config consolidation** — the §10 example is the target surface:
   `auth · tools (NEW slot) · harness · packs · models · store · files ·
   sandbox`, plus per-turn options. Produce **the migration table for all 33
   current keys** — each maps to: a slot · a pack option (generation-ish keys
   → `apps()` pack options) · a harness option (chat-loop knobs like `agent.*`
   → `vendo()` options) · stays-as-is with a stated reason (e.g. `mcp`,
   `oauth`, `policy`, `judge`, `secrets`, `connectors` — adapter-family keys
   §10 doesn't picture but the design doesn't kill) · or deleted (only with
   ZERO consumers, stated). **Additive-first: no shipped host breaks.**
   Deprecated keys keep working shims for one minor (the `model`/`paint`
   precedent), warn once, and the table lands in the docs. Migrate every
   in-repo consumer (demo apps, fixtures, corpus hosts, init scaffold) to the
   new shape. The table is a deliverable — commit it as
   `docs/superpowers/specs/2026-08-01-config-migration-table.md`.
4. **Resurrect the docs gate** — make `handler-options.docs.test.ts`
   exhaustiveness REAL (runtime key-diff against the config type via a
   generated key list, or move the assert somewhere typecheck sees — your
   call), so a config key that misses the docs table fails a test. Wave-1
   law: a gate ships with a test proving it can still FAIL.
5. **Publish-readiness for `@vendoai/harnesses`** — add it to the changesets
   `fixed` group; let changesets align the version (do NOT hand-edit to
   0.6.1); update `PUBLISH.md`; write the wave's changeset. NO npm publish,
   no tag, nothing pushed — publish happens in a later release flow. Flag in
   your lane report: the package needs an npm trusted-publisher entry before
   the next v-tag (an ops step only Yousef can do).
6. **Init-first quickstart** — `vendo init`'s scaffolded route + `docs/
   quickstart.md` + `docs-site` quickstart/handler-options/server-api pages
   updated to the consolidated surface. Keep the edit bounded: pages the
   consolidation touches, not a docs rewrite.
7. **Small truths** — fix the stale "four seats" prose at
   `packages/core/src/harness.ts:69` (code has five; the contract says five).

## Frozen shapes you consume (ask, never diverge)

Contract §1 whole (instant() is a `Harness`; closed event vocabulary; the
runtime mirrors tool calls) · §4 seats (`Seat`/`ResolvedModels`, five seats,
resolution order; boot error on harness-model + seat double-set) · §2
layering · design §10 (the target config, including "boot error" composition
rules and the files-unset degrade path).

## Acceptance (proven by running the real thing; #631 note below)

- **E1, instant column**: the five asks (normal app · edit-in-place ·
  automation · connector action · impossible ask) on `instant()` in a real
  browser. Engine issue #631 makes NEW-app generation fail on strict
  catalogs — NOT yours to fix: app asks run against the seeded demo apps
  (or the permissive toy catalog where the point is the pipeline, not the
  host). Mid-conversation swap instant()→vendo() continues the thread.
- **E6 (hard gates)**: failure rate and latency never worse than today's
  baseline on the flipped default route · real layout on screen ≤5s typical
  via instant() (measured) · `pnpm build && pnpm test && pnpm typecheck &&
  pnpm lint` green from repo root (`pnpm build` BEFORE tests; full suite
  `--force --concurrency=1`; scoped `pnpm --filter <pkg> test`) · genui-bench
  vendo lane still loads and runs.
- **E7 slice**: a guarded call made through instant() produces the same audit
  shape as vendo()'s (the wave-level identical-audit proof is the
  orchestrator's; you prove your column locally).
- **Config proofs**: a host on the OLD shape boots green with deprecation
  warnings; the same host on the NEW shape boots green; the migration table
  covers all 33 keys (the resurrected gate enforces it); `vendo init` output
  composes and runs.

## Out of scope

`claudeCode()`, materialization, sandbox anything (lane E) · steering ·
`/orgs`, `can()` (wave 3) · fixing #631 / quota misclassification / vendoModel
modelId (engine follow-ups) · actual npm publishing or any push/tag ·
`vendo pack export` · deleting keys that still have consumers · anything in
contract §8's cut list.

## Files you own

- `packages/harnesses/src/instant.ts` (new) + its root-barrel export line
- `packages/apps/src/generation/**` (extraction touches; keep public
  re-exports) and `packages/apps/src/index.ts` (append-only)
- `packages/vendo/src/server.ts`, `models-config.ts`, `packages/vendo/src/packs/**`
- `packages/vendo/src/cli/init*.ts` (scaffold output only)
- `packages/vendo/src/handler-options.docs.test.ts`
- `.changeset/config.json` + new changeset files · `PUBLISH.md`
- `docs/quickstart.md`, `docs-site/**` (touched pages),
  `docs/superpowers/specs/2026-08-01-config-migration-table.md` (new)

**Shared, coordinate with orchestrator before non-trivial edits:**
`packages/harnesses/src/index.ts` (append-only), `packages/harnesses/
package.json` (lane E owns it — ASK), `packages/vendo/src/harness-turn.ts`
(lane E owns it — ASK; your default-collapse work may need one edit there:
propose it to the orchestrator as a patch, don't apply).

## Discipline

One worktree, space-free path, this lane only. Base = the rebuild/cutover head
your dispatch names. Seam questions → orchestrator; never diverge locally.
Local decisions not covered above: make them, note every one in your lane
report. Report the moment you finish. Never claim done without acceptance
evidence — done = a real path exercises it; correct-but-caller-less code is
wave-1's biggest failure signal.
