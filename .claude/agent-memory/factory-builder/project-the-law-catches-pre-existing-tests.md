---
name: project-the-law-catches-pre-existing-tests
description: In the rebuild/cutover wave, THE LAW (§12) turned several pre-existing green tests red because they asserted automations doing what §12 now forbids — the ruling is always "fix the expectation, never weaken the law"
metadata:
  type: project
---

During the embedded-agent rebuild (`rebuild/cutover`, 2026-07-31), enforcing
THE LAW from `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md`
§12 ("destructive and external actions are never unattended") turned a series of
already-green tests red. Each one asserted an automation successfully messaging
a human or deleting something in an unattended run. Known instances:

- `fixtures/automations-e2e` ladder test
- `fixtures/integration/src/away-park-revoke.e2e.test.ts`
- `apps/demo-accounting/src/vendo/away-drill.test.ts` (ENG-260 away drill)

**Why:** the tests were written before §12 existed, so a red test here is the
law working, not a regression. Yousef's standing ruling in this wave: never
weaken the law, never relabel the tool, never grant an exception — preserve the
test's *actual subject* by moving its executing step to a legal tool, and add a
separate case pinning the refusal against the exported
`UNATTENDED_DESTRUCTIVE_REASON` constant (never a substring, so test and law
cannot drift). The pattern to copy is
`fixtures/chat-e2e/src/away-runner.e2e.test.ts`.

**How to apply:** if a test in this repo fails with the unattended-destructive
reason, assume the expectation predates the law and fix the expectation. Verify
any replacement tool against the real `resolvedRisk` (both votes, including
`bindingRisk` from the binding's HTTP method) rather than guessing from its
name — DELETE-bound and send/email/message-shaped tools are out. See
[[project-cadence-send-tools-unattended]] for the Cadence demo fallout.
