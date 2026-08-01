---
name: architecture-claims-unimplemented
description: Three embedded-agent architecture claims checked against code 2026-07-31 — one holds, two are absent; don't assume the spec describes shipped behaviour
metadata:
  type: project
---

Verified against code on 2026-07-31 (branch `rebuild/cutover`). The
2026-07-30 embedded-agent architecture spec describes intent, not always
shipped behaviour. Three §3/§7 claims were checked:

- **`audit ⊇ transcript` (§3) — HOLDS**, now asserted in
  `packages/vendo/src/audit-superset.e2e.test.ts`. Caveat: read strictly
  as sets it is false, because §3 routes `text` to the transcript with no
  audit row. The true invariant is over *accountable* events (guarded
  calls, approvals, errors, hires, usage). Proposed narrower wording is
  in that file's header.
- **Review failure protocol (§7) — HALF BUILT since 2026-08-01.** The FAIL
  half now exists as a REFUSAL, not a flagged version: a `block` surviving
  the conductor's pre-land `FIX_ROUNDS` stops the write at the commit path
  in `packages/apps/src/runtime.ts` (create fails the build before it
  emits or persists; edit returns before `persistEdit`, so the previous
  app stays in its row and keeps serving). Proven by
  `packages/apps/src/checking/commit-gate.test.ts`. **Still absent:** the
  flagged version itself, a post-land fix round, a failure card with two
  choices, any owner override, and `Finding` provenance — so "except
  host-check failures" still cannot be evaluated. Skipped tests naming the
  remainder: `packages/apps/src/checking/review-failure-protocol.test.ts`.
- **Failure-card per-firing dedupe + skipped-run count (§3) — ABSENT.**
  The `(appId, tool)` dedupe that exists is *enable-time* in
  `packages/automations/src/engine.ts` (already tested there). On the fire
  path `#parkApproval` mints a fresh `apr_<uuid>` with no lookup, so N
  failed firings leave N standing cards. No counter field exists on
  `ApprovalRequest`. There is no launcher badge at all.

**Why:** the live prover refused to mark these proven and was right to; a
later lane that trusts the spec's wording will build on sand or "fix"
working code to match a sentence.

**How to apply:** before implementing or testing against a sentence in
that spec, grep for the mechanism first. Report a false claim as false —
that outcome is worth more than a green test. See
[[project-the-law-catches-pre-existing-tests]] for the sibling case where
the spec was right and old tests were wrong.
