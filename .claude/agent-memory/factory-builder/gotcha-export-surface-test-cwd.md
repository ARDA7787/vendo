---
name: gotcha-export-surface-test-cwd
description: packages/ui/test/chrome/export-surface.test.ts resolves from process.cwd(), so running it via `vitest --root packages/ui` from the repo root reds it with a bogus TS2307
metadata:
  type: project
---

`packages/ui/test/chrome/export-surface.test.ts` shells out to a real `tsc`
against a fixture it writes into `process.cwd()`, with the comment "vitest runs
with cwd = the package root". Running the suite as
`npx vitest run --root packages/ui` **from the repo root** breaks that
assumption: cwd stays at the repo root, the fixture's `./src/chrome/index.js`
import cannot resolve, and you get

    error TS2307: Cannot find module './src/chrome/index.js'

on BOTH of its tsc-driven cases — including the negative "has teeth" case, whose
failure to contain `TS2305` is the tell that tsc died for an unrelated reason.

**Why:** it looks exactly like the real failure mode of that test (a chrome
export added without pinning it in the registry), so it will send you hunting a
regression you did not cause.

**How to apply:** run ui tests as `cd packages/ui && npx vitest run`, never with
`--root` from the repo root. `pnpm test` at the root is fine — turbo runs each
package in its own directory. If those two cases fail together, check the error
text for TS2307 before touching any export.

Related: [[gotcha-ui-chrome-export-registry]], [[gotcha-ui-browser-suite-preexisting-reds]]
