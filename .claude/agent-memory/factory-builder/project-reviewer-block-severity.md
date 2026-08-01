---
name: reviewer-block-severity
description: What the reviewer rubric emits `block` for — four categories, one of them (quietly-dropped work) is judgment-shaped and now stops a write
metadata:
  type: project
---

`packages/apps/src/generation/prompts/reviewer.ts` (REVIEWER_SYSTEM) is the
only place that decides which generated-app problems are `block`. As of
2026-08-01 a `block` stops the write, so this list is load-bearing:

- **block** — (1) invented data, incl. a broken binding that renders nothing
  or the wrong number where a label promised one; (2) dishonest tool use;
  (5) work the person explicitly asked for that the app quietly dropped.
- **warn** — (3) dead or ungrounded controls; (4) sections that don't answer
  the ask. The prompt also forbids taste findings outright.

**Why this matters:** (1) and (2) are evidence-shaped — a literal is checked
against the resolved query data, a tool against its own description.
(5) is **judgment-shaped**: it asks the reviewer to decide whether the app
fulfils the ask, from the ask's own words. A false positive there now costs
the person their app, not just a warning line. That is a product call for
Yousef, flagged 2026-08-01, not settled.

Note also that "a dead button" is **warn**, not block — the intuition that
dead controls block is wrong.

**How to apply:** before changing any severity in that prompt, or before
assuming a category blocks, read the prompt. Widening `block` is a product
decision; narrowing it weakens the floor. See
[[architecture-claims-unimplemented]] for what the floor does and does not
do after a FAIL.
