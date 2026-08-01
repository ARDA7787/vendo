---
name: gotcha-store-postgres-export-mirror
description: Adding an export to packages/store/src/index.ts fails a surface test unless it is mirrored in postgres.ts
metadata:
  type: project
---

Every export added to `packages/store/src/index.ts` must ALSO be added to
`packages/store/src/postgres.ts`, or `postgres-entry.surface.test.ts` fails with
`main-entry export "X" missing from ./postgres`.

**Why:** `./postgres` is the engine-agnostic entry a Workers/edge deployment
imports so PGlite never enters the module graph. The surface test asserts the
two entries offer the same names, so an export that lives only on the main entry
silently makes that entry point second-class.

**How to apply:** when a lane adds any store door (`harnessStateStore`,
`workspaceBash`, …), append it to both files in the same edit. The failure shows
up as one red test in an otherwise-green scoped run, far from the file you
changed — the check is only enforced one way (main → postgres), so a
`postgres`-only export would still drift unnoticed.

Related: [[env-worktree-path-space-red]]
