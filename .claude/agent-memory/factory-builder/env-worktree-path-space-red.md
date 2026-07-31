---
name: env-worktree-path-space-red
description: Flowlet worktrees under a path containing a space fail 7 tests in 3 packages (undecoded file URLs) — pre-existing, never a lane's bug
metadata:
  type: project
---

Flowlet worktrees on this machine live under `/Users/yousefh/Desktop/Cool Code/…`
— the space in `Cool Code` breaks every test that resolves a fixture through a
file URL without decoding it (`%20` survives into the path). Seven tests fail in
any such worktree, in three packages, with zero code changes:

- `packages/store/src/durability.drill.test.ts` (1) and `split-brain.drill.test.ts` (1)
  — `Cannot find module '…/Cool%20Code/…/__fixtures__/drill-writer.mjs'`
- `packages/core/src/packaging.e2e.test.ts` (3)
  — `Failed to load url …/Cool%20Code/…/.e2e-pack/package/dist/index.js`
- `packages/vendo/src/dev-creds/model.test.ts` (2) — separate cause, same class of
  environment sensitivity: `require.resolve('@ai-sdk/anthropic')` from a temp root
  with global paths stripped.

**Why:** the orchestrator's "green baseline" usually looks clean because turbo
replays a *cached* result produced in the main checkout (`~/orca/workspaces/flowlet/format`,
no space), so these never surface there — only in a fresh worktree run.

**How to apply:** on a lane's baseline check, expect these 7 and treat them as
pre-existing rather than stopping the lane. Confirm cheaply by running the one
file at the lane's base commit (`git checkout <base>` in the worktree, run the
file, `git switch -` back) — the failure text is identical. The real fix is
`fileURLToPath()` instead of `.pathname`/href, which `scripts/dependency-guard.mjs`
already documents for exactly this reason; it belongs to whoever owns those test
files, not to a lane that merely observed it.
