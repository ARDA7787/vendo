---
name: gotcha-stale-dist-phantom-results
description: In the flowlet monorepo, sibling packages import @vendoai/* from dist not src — always run pnpm build before testing a single package, or you get phantom passes and phantom failures
metadata:
  type: project
---

Always run `pnpm build` before running a scoped test in this monorepo. Sibling
packages and the demo apps resolve `@vendoai/core`, `@vendoai/guard` etc. from
`dist`, not `src`.

**Why:** during the `rebuild/cutover` wave this produced both phantom passes and
phantom failures repeatedly — a source edit that was never rebuilt simply did
not exist as far as the test run was concerned. This is also why a mutation
probe on production code must be followed by a rebuild of that package's
dependents (`pnpm build --filter @vendoai/core...`) before the probe's RED can
be observed, and by another rebuild after reverting.

**How to apply:** `pnpm build` first, every time, before any scoped
`pnpm --filter <pkg> test`. Never run the full monorepo suite in a factory lane:
parallel vitest runs EPIPE-crash each other. Known pre-existing failures that
are space-in-path artifacts, not real: 3 core `packaging.e2e`, 2 vendo
dev-creds/model, 2 store durability drills.
