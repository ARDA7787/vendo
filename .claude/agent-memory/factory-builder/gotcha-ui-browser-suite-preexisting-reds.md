---
name: gotcha-ui-browser-suite-preexisting-reds
description: packages/ui's playwright suite carries pre-existing reds (chrome-behavior thread+overlay, accessibility automations+stage) — classify by reverting your file, never assume they are yours
metadata:
  type: project
---

`pnpm --filter @vendoai/ui test:browser` (118 cases) is NOT green on
`rebuild/wave3-stage` as of 2026-08-01. Known pre-existing failures:

- `e2e/chrome-behavior.spec.ts` — "thread sends a real streamed turn…" and
  "overlay traps focus…" (also flaky: 4 vs 5 failures across runs)
- `e2e/accessibility.spec.ts` — `automations` and `stage` axe checks. The
  automations one is `aria-prohibited-attr` on
  `<div class="fl-auto-runs" aria-label="Last N runs for …">` — an `aria-label`
  on a div with no role. Pre-existing markup, one attribute to fix.

**Why:** it is easy to attribute these to your own diff and spend a round
chasing them. `pnpm test` (the CLAUDE.md gate) does not run playwright, so they
do not block the stated gate.

**How to apply:** to classify a browser red, restore ONLY your file
(`git show <sha>:path > path`, never `git stash` — see
[[feedback-git-stash-is-repo-wide]]) and re-run the same spec. Same failure ⇒
not yours. Also: never run playwright while editing source — vite hot-reloads
mid-run and invalidates the whole result.
