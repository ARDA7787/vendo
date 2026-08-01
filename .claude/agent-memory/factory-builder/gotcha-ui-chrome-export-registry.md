---
name: gotcha-ui-chrome-export-registry
description: Adding any value export to packages/ui/src/chrome/index.ts fails export-surface.test.ts until the name is listed there too
metadata:
  type: project
---

`packages/ui/test/chrome/export-surface.test.ts` holds a hand-maintained
`VALUE_EXPORTS` array and asserts `Object.keys(chrome).sort()` equals it
exactly. Any new value export from `packages/ui/src/chrome/index.ts` (a
component, a helper) turns that test red until the name is added to the array.
Type-only exports are covered by a separate generated `tsc --noEmit` fixture in
the same file.

**Why:** the array is a deliberate guard — the thread refactor had to keep
`@vendoai/ui/chrome`'s public surface identical, so the surface is pinned
rather than inferred.

**How to apply:** when a lane adds a chrome export, edit the array in the same
commit. The failure only surfaces on a full `pnpm --filter @vendoai/ui test`
(~55s), so it is easy to miss when running a single scoped test file. Related:
[[gotcha-stale-dist-phantom-results]].
