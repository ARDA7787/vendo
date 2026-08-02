---
name: gotcha-tsc-force-flag-silent-build-fail
description: `pnpm --filter <pkg> build --force` passes --force to tsc, which rejects it — the dist never rebuilds and a red-green check silently proves nothing
metadata:
  type: project
---

Package `build` scripts here are `tsc -p tsconfig.json`. `pnpm --filter <pkg>
build --force` appends `--force` to THAT command, not to turbo, and tsc exits 1
on the unknown flag. If the output is redirected to /dev/null, the dist keeps the
OLD code and every subsequent test result is about code you thought you had
replaced.

**Why:** during the 2026-08-01 wave-2 fix round this made a revert-the-fix
red-green check report GREEN — the "reverted" behaviour was never built. It was
caught only because a manual run of the same probe printed the fixed message.
A second near-miss: `grep "give the harness a sandbox"` returned nothing because
tsc emits that string split across two concatenated lines, which looked like
confirmation that the revert had landed.

**How to apply:**
- To force one package: `cd packages/<pkg> && npx tsc -p tsconfig.json`. To force
  the repo: `pnpm build --force` (turbo owns that flag at the top level).
- Never redirect a build to /dev/null during a red-green check; read the exit code.
- Verify a revert landed by grepping the DIST for a short, single-line fragment,
  or better, by running the probe and reading the actual output.
