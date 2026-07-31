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
- **Review failure protocol (§7) — ABSENT.** `edit()` in
  `packages/apps/src/runtime.ts` calls `persistEdit` and only afterwards
  filters blocking findings into an advisory `issues: string[]`; `create()`
  `console.info`s them. No version status on `AppDocument`, no
  served-version pointer, no failure card, no owner-override, and
  `Finding` has no provenance so "except host-check failures" cannot even
  be evaluated. Skipped tests naming the work:
  `packages/apps/src/checking/review-failure-protocol.test.ts`.
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
