---
name: gotcha-generic-adapter-needs-explicit-refs
description: A reserved-collection write that omits `refs` is unreadable on the hosted store and any BYO adapter — the local engine derives refs from columns, generic adapters keep only what you pass
metadata:
  type: project
---

A store helper that writes a reserved collection through `store.records(...).put()`
must pass the `refs` it later QUERIES BY, explicitly. Found 2026-08-02 in
`appAccess.grant` (`packages/store/src/helpers/app-access.ts`): it wrote grant rows
with `data` only, so `grantsFor`'s `list({ refs: { app_id } })` matched nothing on
any store whose record door is generic.

**Why:** the local Postgres/PGlite engine ROUTES reserved collections
(`packages/store/src/routing.ts`) and rebuilds `refs` from the row's own columns on
read, so the omission is invisible there. `hostedStore` posts the record to the
console verbatim, and `memoryStoreAdapter` (core/conformance, the reference BYO
adapter) has no case for newer collections — both keep only the refs you gave.
Precedent already in the codebase: `guard.ts #recordEffect` passes
`refs: { subject }` with a comment saying exactly this, and the apps test fixture
(`packages/apps/src/testing/app-access-fixture.ts`) passed refs while the real
store implementation did not.

**How to apply:** when adding or reviewing a reserved-collection write, check that
every ref key the read path filters on is in the `put`. Testing it needs a
non-routing store shape — a `hostedStore` over `fakeConsole()` in
`packages/vendo`, not the store package's pglite/postgres backends, which pass
either way. See [[gotcha-store-postgres-export-mirror]] for the sibling trap.
