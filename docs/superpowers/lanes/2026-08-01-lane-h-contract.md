# Lane H handoff contract — sponsorship + org policy (wave 3)

**2026-08-01, wave-3 orchestrator.** You are a factory builder. Build this
contract to completion in YOUR OWN worktree (path has no spaces; you will be
told it). Branch off `rebuild/cutover` at the base commit you were given.
NEVER push, PR, or merge. Commit locally. Seam questions go to the
orchestrator; never diverge from frozen shapes locally.

## Read first

1. `docs/superpowers/specs/2026-07-30-build-contract.md` — §9.9–9.10 are YOUR
   shapes, frozen; §9.1–9.4 are lane G's shapes you build AGAINST (G runs in
   parallel — you consume the frozen interfaces, not G's code; stub
   `AppAccess`/`memberships` in your tests with the exact frozen signatures).
2. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md`
   §13 (sponsorship — the LOCKED adoption-card decision), §14 (org policy),
   §12 (THE LAW context).
3. `docs/superpowers/lanes/2026-08-01-wave3-orchestrator-brief.md`.

## Locked decisions you implement (violating one fails the lane)

- An automation always runs as a named person — its sponsor. Sponsorship is
  a light ceremony, not a security perimeter (§12 already bounds what
  unattended runs can do).
- Adoption = the card waits IN the app. No approval-addressing primitive,
  nothing pushed to a set of people; the next editor+ to open the app may
  adopt, approving the automation's reads/writes AS THEMSELVES. Approvals
  stay strictly self-subject.
- Sponsorship invalidates on: sponsor departure, sponsor's grants
  invalidating, or ANYONE ELSE editing the app.
- Org policy tightens, never loosens; host policy always wins; evaluated by
  the same guard. No argument predicates (kill-list A4 stands — the spec's
  "$10k" example is NOT expressible in v1 and you do not re-add predicates).

## Build list

### 1. Sponsorship state + engine threading (contract §9.9)

- The `automations:sponsorships` routed-collection record exactly as frozen
  in §9.9 (generic records door is fine here — this is engine-internal
  state like `automations:captures`, not a §9.2-style reserved table).
- Mint/refresh at enable (`packages/automations/src/engine.ts:1068-1149`):
  sponsor = the enabling subject; `intentHash` = core `intentHash()`
  (`packages/core/src/grant-sets.ts:31-39`) over §7's `AppIntent`
  {name, tools (declared surface, `[]` for agentic), trigger, runBody —
  derive runBody deterministically from the doc's run definition; note your
  derivation in the lane report}.
- Run identity: `runContext` (`engine.ts:473-480`) resolves the active
  sponsorship's sponsor, falling back to the row subject; all four callers
  (`engine.ts:710, :867, :872, :1533`). TRAP (recon-proven): `appRowSchema`
  at `engine.ts:52-56` is a non-passthrough zod object while
  `packages/apps/src/persistence.ts:44-48` duck-types the same row — you are
  NOT adding fields to the app row (state is your own collection), but if
  you touch the row parse at all, fix the drift hazard rather than widening
  it.
- Fire-time check in `launchRun` (`engine.ts:695-733`), BEFORE any step or
  agentic dispatch: sponsorship `active` + sponsor still `can(editor)` on
  the app (via the engine's new `appAccess` + `memberships(principal)`
  config seams — G's frozen §9.1/§9.3 interfaces; take both as optional
  config, absent ⇒ ownership-only check) + `intentHash` matches the current
  doc. Any failure: mark invalidated (with `reason`), do NOT run, mint the
  adoption card, audit a run event with status `"sponsorship-invalidated"`
  (consumer-voice summary). The run must fail loudly, never silently skip.

### 2. Invalidate on third-party edit

- Implement the consumer of lane G's `onDocumentEdit` hook (frozen §9.9):
  when `editor !== sponsor` and a sponsorship is active → invalidate
  (`reason: "edit"`). The hook arrives via apps config; wire it at the
  server composition seam (`packages/vendo/src/server.ts`, automations
  region `:2377-2384`) — automations exposes the handler, composition
  connects it. Until G lands, test through your own direct call of the
  handler; the persistEdit plumbing itself is G's, not yours.
- Sponsor's OWN edit does not invalidate sponsorship (it may invalidate
  the grant set — that is the automations-pack session's work, not yours).

### 3. The adoption card (contract §9.9)

- New file `packages/automations/src/adoption.ts` (or in-engine module —
  your call): pending-adoption state derived from invalidated sponsorships;
  additive venue state riding the app open payload via the
  `inclient.ts:80-98` `venueStateFor` pattern (injection point at
  `packages/apps/src/runtime.ts:1168` region — G keeps it composable; you
  add your own state provider, exposed from automations and composed at the
  server seam). Served ONLY to callers with `can(editor)` on the app.
- Card content: consumer-voice, the automation's name, why it stopped, and
  one line per read/write from its declared surface (§12 completeness:
  real tool titles + material arguments where they exist; never a single
  summary line for a compound).
- Accept path: the adopter decides through the EXISTING approvals door
  (`guard.ts` approvals are self-subject by construction — keep it that
  way): mint the needed `ApprovalRequest`s/grant set under the ADOPTER's
  subject reusing the enable-capture machinery (`engine.ts:1080-1131`),
  then CAS the sponsorship row to `{sponsor: adopter, status: "active",
  intentHash: current}` — first editor+ to complete wins; a lost CAS shows
  "already adopted" honestly. Subscribe on `guard.onApprovalDecision`
  (`guard.ts:381-386`) like the three existing consumers.
- UI: an adoption card component in `packages/ui/src/chrome/` following
  `grant-set-card.tsx`; render from the venue state.

### 4. Window labels

- `automations.list()` (`engine.ts:1157-1182`) gains the sponsor (subject +
  display when resolvable); render "runs with <name>'s access" in
  `packages/ui/src/chrome/automations-panel.tsx:272-290` and
  `automation-card.tsx`, consumer-voice. Name a wider editor set when one
  exists (grants count from `AppAccess.list` if configured; omit otherwise).

### 5. Org-admin policy layer (contract §9.10)

- Parse/validate `vendo/org-policy@1` (new small module in
  `packages/guard/src/org-policy.ts`): `PolicyRule[]` with `action` ∈
  {ask, block}; `"run"` fails parse loudly (tighten-only by construction).
- `CreateGuardConfig` gains `orgPolicy?: (ctx) => Promise<PolicyRule[]>`
  (`packages/guard/src/types.ts:155-169`).
- Evaluation: post-pipeline strictness clamp in `#checkWithMetadata`
  between the away-downgrade (`guard.ts:687-689`) and the breakers
  (`:691-709`): match rules with the existing `ruleMatches`
  (`policy.ts:171-185`); `final = stricter(draft, org)` on rank
  `run < ask < block`; when org changed the outcome set
  `decidedBy: "org"`. Widen the three unions: `GuardDecision`
  (`core/src/guard.ts:9-31`), `AuditEvent.decidedBy`
  (`core/src/audit.ts:22,39`), pipeline-conformance stage matrix
  (`packages/guard/test/pipeline-conformance.test.ts:13`). The clamp MUST
  bind grant-authorized drafts (that is the point); it must NEVER loosen
  anything; THE LAW's call-time gate (`guard.ts:491-513`) stays after it,
  untouched. Red-green tests for both directions (tightens a grant-run;
  cannot loosen a host block).
- Composition: at the server seam, resolve org policy files for
  `ctx.memberships` orgs by reading `/orgs/<orgId>/policy.json` through the
  store's workspace rows (read path only — the admin-only WRITE rule on
  that path is lane G's mount code). Memoize per check at minimum; note
  your caching choice. Absent file / no memberships ⇒ empty rules.
- A malformed org policy file fails CLOSED for org members (treat as
  `[]`? NO — treat as `[{match:{}, action:"ask"}]`-equivalent is
  over-reach; instead: log + audit a policy-decision warning and apply no
  org rules, exactly like the actions layer refuses to silently LOOSEN
  (`registry.ts:897-899` posture). State this trade in your report.

## Frozen shapes consumed (do not re-derive, do not modify)

§9.1 `Membership` + engine `memberships` seam · §9.3 `AppAccess`/`can()`
signatures (stub in tests; integration wires the real one) · §9.9 your
sponsorship record + `onDocumentEdit` hook signature · §9.10 org-policy
shape · §7 `GrantSet`/`intentHash` (helpers at `core/src/grant-sets.ts` —
consume, don't reshape). GrantSet's FULL production wiring
(rename-invalidation, bundle-eligibility, enable-flow deltas) belongs to the
automations-pack session — you wire only what sponsorship needs
(intentHash compare + re-mint under the adopter). Do not restructure the
enable flow.

## Acceptance

- E8 slices provable with stubs: sponsor invalidated (each of the three
  reasons) → run stops loudly before any tool call + adoption state
  appears; non-editor never sees the adoption card; adoption re-mints
  grants under the adopter and runs continue as the adopter; third-party
  edit invalidates, sponsor's own edit does not.
- Org policy: a grant-authorized `run` clamps to `ask`/`block` per org rule;
  a host `block` is never loosened; `decidedBy:"org"` lands in the audit
  row; conformance matrix updated and green; malformed file → no silent
  loosening, audited.
- Every gate ships a test that proves it can still FAIL (red-green pair).
- Scoped gates green from YOUR worktree: `pnpm build`, then `pnpm --filter
  @vendoai/automations --filter @vendoai/guard --filter @vendoai/core
  --filter @vendoai/apps --filter @vendoai/ui test`, `pnpm typecheck`,
  `pnpm lint`. No new dependency-guard edges (automations must NOT import
  from store directly — take `AppAccess` as config).
- Known base reds not yours: space-in-path worktrees (yours won't have
  one); engine issue #631 (generation) — use seeded apps in any e2e.

## Out of scope (do not build)

The §3 notification hook (the card is pull-only; announcing it later is an
upgrade) · approval addressing of any kind · `operator` level · grant
conditions/scopes/argument predicates · the flagged-version/review override
machinery · the automations-pack redesign (outbox, prepare, agent steps —
separate session; your sponsorship state must not collide with
`docs/superpowers/specs/2026-07-30-automations-pack-design.md`'s committed
shapes — read its §s on enable/consent before naming collections) · console
anything · membership storage.

## Files you own

`packages/automations/src/**` · `packages/guard/src/{org-policy.ts,guard.ts
(clamp region),types.ts,policy.ts (read-only reuse)}` ·
`packages/core/src/{guard.ts,audit.ts}` (the `decidedBy` widening ONLY) ·
`packages/ui/src/chrome/{adoption-card.tsx,automations-panel.tsx,
automation-card.tsx}` · `packages/guard/test/**`, `packages/automations`
tests. You do NOT touch `packages/apps/src/runtime.ts` or
`packages/store/**` (lane G owns them; your two integration seams arrive as
config). If you need a line there, ask the orchestrator.

## Report

Branch + final commit hash, what you built, local decisions (runBody
derivation, caching, collection names), test tally, and anything the
contract got wrong. Sincere claims only — an independent verifier runs
after you.
