---
name: gotcha-doc-block-orphaned-by-insertion
description: This codebase's doc blocks are long, so inserting a const or function directly under one silently reassigns it to the wrong symbol — a recurring defect, and easy to commit while fixing it
metadata:
  type: project
---

Vendo's source carries unusually long `/** */` blocks (often 8-15 lines of
contract reasoning). Adding a new symbol immediately below one silently
re-parents that whole block to the new symbol, and the prose then describes
something it is not.

**Why:** it has happened repeatedly and is invisible in review — the diff shows
only the added lines, never that a comment 12 lines up now lies. Wave 3 shipped
commit `a134d13ed` ("the resolve route sits above the comment it is not") for
exactly this in `packages/vendo/src/wire/apps.ts`, and the same wave still had
three more live instances (`apps/src/runtime.ts` box door,
`automations/src/engine.ts` runContext, `ui/src/tree/renderer.tsx` pinDrift).
During the simplify pass I introduced a fresh one myself by putting a new
`TAKE_IT_ON` const between the `SPONSORSHIP_STOP` doc block and
`SPONSORSHIP_STOP`.

**How to apply:** when inserting a symbol, look UP first — if the line above is
`*/`, put the new symbol above that block, not below it. When reviewing a wave
that had several fix rounds, grep changed files for two `/** */` blocks stacked
with no code between them; that pattern is almost always an orphan. The standing
rule is that a comment claiming a guarantee the code does not provide must
become true or go.
