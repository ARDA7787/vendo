# Wave-3 orchestrator brief (handoff from the wave-1 session, 2026-08-01)

You are the orchestrator for wave 3 — multi-party (the Cloud half). Every
product decision this wave needs is ALREADY LOCKED with Yousef (2026-08-01).
Do not re-open them; do not ask him to re-decide.

## Sequencing

Wave 3 needs wave 1 (done) and lane B's workspace (done). It does NOT need
wave 2's harnesses — but wave 2 runs on the same `rebuild/cutover` branch.
Coordinate integration order with the wave-2 session if both are landing:
whoever lands second rebases and re-runs the gates.

## Read first, in order

1. `docs/superpowers/specs/2026-07-30-build-contract.md` — FROZEN; you
   inherit ownership for your lanes' shapes (amend it yourself, lanes never
   diverge locally).
2. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md`
   — §8 (workspace + permissioning, carries the 2026-08-01 LOCKED
   amendments), §13 (sponsorship), §14 (org policy), §11 (the Cloud line).
3. `docs/superpowers/specs/2026-07-30-implementation-and-evaluation-plan.md`
   §4 — Lane G orgs + `can()` (AMENDED 2026-08-01 — read the amended text),
   Lane H sponsorship + org policy. Proof bar: E8.
4. Memory notes `vendo-embedded-agent-architecture` (wave-3 decisions
   section) and `vendo-rebuild-wave1-build` (environment gotchas, rulings).

## The locked decisions (2026-08-01, with the industry evidence behind them)

1. **The host's identity system IS the org.** Memberships are NEVER Vendo
   rows. The auth preset gains a `memberships` callback — host code, one
   query against their own tables, returning the user's orgs/teams. It is
   server code in the host's own deployment, so unattended runs (sponsor
   checks at fire time) call it WITHOUT a session. Evidence: two-agent
   survey — Liveblocks/TipTap/Metabase/Sigma/LaunchDarkly all assert
   per-session; Cord (the one org-sync vendor) is dead; WorkOS sells sync's
   pain as a standalone product.
2. **Vendo stores only grants** (app → principal → level), written by the
   Share dialog in the embedded surface, behind whatever store the host
   wired. `can(principal, level, thing)` = ownership + asserted memberships
   + grant rows; one function, three doors (façade, wire, MCP).
3. **Console:** hosted-tier customers (no identity system) get full org
   management — the console writes to Cloud's own hosted store. BYO
   customers get at most a READ-ONLY observed view (last-asserted
   users/teams/shares). There is NO console channel into a host's database —
   don't build one.
4. **Gating stays key + meter, nothing else:** share/promote throw
   `cloud-required` without a key; `can()` is OSS and never key-conditional.
5. **Sponsorship adoption = the card waits in the app.** No
   approval-addressing primitive, nothing pushed: a stopped automation is a
   card on the app itself; the next editor+ to open it may adopt (one card,
   approving its reads/writes as themselves). Approvals stay strictly
   self-subject. When the §3 notification hook is someday built, it
   announces this same card — upgrade, not rework.
6. Everything already in the spec stands: viewer/editor/owner closed
   vocabulary, fork offer to viewers, share-implies-promote, fork/promote as
   the only two verbs, registry = dead snapshots, org admins are implicit
   owners, checkout+commit `can()` for sandboxes, served org apps are a wire
   door, org policy tightens never loosens.

## Known must-address from the wave-1 deep review (finding list in memory)

- Contract-§7 GrantSet/intentHash helpers exist in `packages/core/src/
  grant-sets.ts` but have zero production consumers — if lane H touches
  consent, wiring them (rename invalidation, bundle-eligibility refusal)
  belongs to the same work; coordinate with the automations-pack session.
- `/orgs` mounts commit via CAS (per-file compare-and-swap); `/user/` is
  last-write-wins. Already in the contract.

## Ground rules (Yousef's, standing — same as every wave)

- Worktree `/Users/yousefh/orca/workspaces/flowlet/format`, branch
  `rebuild/cutover`; builders in own worktrees, paths without spaces.
- NEVER push, PR, or merge. Factory discipline: lane contracts → parallel
  builders → independent adversarial verify per lane → integrate →
  wave-level check → simplify.
- Done = proven by running the real thing (E8: two real users in a real
  browser, share, fork, revoke, adopt). Never grade your own homework.
- `pnpm build` before any test run; full suite `pnpm test --force
  --concurrency=1` from repo root; scoped `pnpm --filter <pkg> test`.
- Report to Yousef like a CEO; facts and bugs are yours, genuinely new
  product decisions (there should be none) go to him one at a time.
