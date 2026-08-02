---
name: gotcha-concurrent-vitest-breaks-e2e-fixtures
description: Running a scoped vitest while the full suite is in flight reds the e2e fixture packages ("Fixture reset failed (500)") — they own a real Next server and a shared store
metadata:
  type: feedback
---

Never run `pnpm --filter <pkg> exec vitest` while `pnpm test` is in flight in the
same worktree. The `@vendoai-fixtures/*-e2e` packages boot a REAL Next server on a
fixed port against a shared fixture store, so a second concurrent run collides and
the failure surfaces far away as `Error: Fixture reset failed (500)` in
`park-and-audit.e2e.test.ts` — nothing to do with the code under test.

**Why:** cost me a full-suite re-run on 2026-08-02. The full suite was mid-flight
when I re-checked two scoped files after a cosmetic edit; `mcp-e2e` then failed and
looked like a regression in the wire changes I had just made.

**How to apply:** decide up front which run is the run of record. Do scoped
red-green checks BEFORE launching the full suite, and once it is launched, touch
nothing in the repo (not even another vitest) until it reports. If a fixture-e2e
package fails with a 500/port/lock-shaped message, check for contention before
debugging the code. Companion to
[[gotcha-nohup-dev-server-reaped]] and [[gotcha-stale-dist-phantom-results]].
