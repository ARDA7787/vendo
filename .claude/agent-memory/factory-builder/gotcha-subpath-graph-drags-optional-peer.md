---
name: gotcha-subpath-graph-drags-optional-peer
description: A package subpath that re-exports an SDK-touching module puts that SDK in every host's Turbopack build graph — split the subpath, don't just declare the peer
metadata:
  type: project
---

An optional peer is only optional if no module a host imports NAMES it.
Turbopack constant-folds `await import(SOME_CONST)`, so the "variable specifier
trick" does NOT hide a package from a Next.js build — it resolves it and fails
the build with `Module not found`.

**Why:** `@vendoai/apps/internal` re-exported `claude-turn.js`, and
`packages/harnesses/src/render-seam.ts` imports `./internal` statically on every
composed host's server path. So `@anthropic-ai/claude-agent-sdk` was demanded at
BUILD time from `apps/demo-bank`, which has no reason to install a ~250MB
platform binary. `harness: claudeCode()` was therefore uncommittable to a real
host. Fixed 2026-08-01 by giving the runner its own subpath
(`@vendoai/apps/claude-turn`), making `sdk` a REQUIRED input so the runner never
names the package, and loading it in exactly one host-path file behind
`/* turbopackIgnore: true */ /* webpackIgnore: true */`.

**How to apply:** before adding any SDK-touching module to a package, ask which
subpath reaches it and who imports that subpath. Verify with a real host build
(`pnpm --filter demo-bank build`), not with a unit test — the import trace in
the Turbopack error names the exact chain. `tsc` preserves the magic comments
into `dist`, so they survive the build; confirm with
`grep turbopackIgnore <dist file>`.

Related: [[gotcha-claudecode-in-nextjs-host]] (the earlier, wrong diagnosis that
Turbopack "refuses every dynamic form" — it does not; it resolves them).
