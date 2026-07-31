---
name: project-maple-law-gaps
description: Three open §12 gaps found in the Maple flagship demo on 2026-07-31 — a money tool labelled `write`, shipped narration promising unattended emails the automations cannot send, and a background seed labelling itself attended
metadata:
  type: project
---

Found while fixing Maple's ENG-260 away drill (`apps/demo-bank`, the flagship
demo at maple.vendo.run and demos.vendo.run/maple). None were fixed — the lane
was test-only — and none are live violations today. All three need a founder call.

1. **`host_createOrder` is a money-mover labelled `write`.** Its own description
   says "This MOVES MONEY: it charges the user's card", but `resolvedRisk` is
   `write` (no `DESTRUCTIVE_VERBS` token in `host_create_order`, POST binding),
   so §12's projection filter does NOT withhold it from unattended runs. No
   automation binds it, so nothing is exploitable — the *label* is the hole.

2. **Shipped narration promises unattended emails that never happen.** Maple's
   two seeded automations only read (`host_getSpendingInsights`,
   `host_listTransactions`, `host_listAccounts`), yet the scenario cards,
   automation card text, and scripted narration all say Maple will "email" a
   digest / an alert while the user is away, and the script even streams a
   fake `gmail_send_email` tool part. §12-correct code, §12-contradicting story.
   This is the demo-truth question, not a bug.

3. **Chip pre-generation labels itself `presence: "present"`** while running
   with no request and no human, and mints a wildcard `host_*` standing grant.
   §12's filter is presence-only, so destructive tools are projected into that
   generation prompt's tool menu. Nothing executes them (read-only gates
   upstream), but an unattended path is declaring itself attended.

**Why:** Maple is the flagship demo, so a §12 story that the demo itself
contradicts is a credibility problem, not a code problem.

**How to apply:** raise these as decisions, not fixes. Related:
[[project-the-law-catches-pre-existing-tests]].

Structural fact worth knowing before touching Maple automations: Maple's ENTIRE
mutating API surface is `/api/transfers` (money), `/api/orders` (money),
`/api/demo/reset` (destructive), `/api/voice` (on a PUBLIC proxy prefix, so a
write there bypasses the auth wall) and `/api/demo/pin` (writes the *server's*
store, invisible to a test's own store). So under §12 a Maple automation can
legally do nothing but read — which is why its away drill now executes
`host_getProfile`.
