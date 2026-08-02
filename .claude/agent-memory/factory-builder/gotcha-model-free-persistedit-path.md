---
name: gotcha-model-free-persistedit-path
description: In @vendoai/apps only pins.fork reaches persistEdit without a model — schedule() and inClient.approve() do NOT, so tests built on them silently prove nothing
metadata:
  type: project
---

`persistEdit` in `packages/apps/src/runtime.ts` is the choke point that rings
`onDocumentEdit` (build contract §9.9). To drive it in a test WITHOUT scripting
the whole brain/fill pipeline, the only model-free path is
`apps.pins.fork({ appId, slot }, ctx)` — it copies a captured baseline and lands
an ordinary recorded edit with no model call.

**Why:** `runtime.schedule()`, `inClient.approve()`, `egressApproval` and
`history().undo()` all write through `updateAppDocument`/`updateAppRow` or the
row door directly, so they never touch `persistEdit` and never ring the hook.
An existing apps test asserted the hook using `schedule()` + `.catch()` plus
`seen.every(...)` over an array that stays EMPTY — vacuously green.

**How to apply:** driving a real edit from `packages/vendo` means
`createVendo({ profileDir })` with a `.vendo/remixable/<slot>.json` baseline
(`{slot, source, hash, exportable, capturedAt, sampleProps}`) — that is the whole
cost of a genuine end-to-end edit. If a test needs the hook, use pins.fork; if it
uses schedule(), the assertion is fake. See [[gotcha-stale-dist-phantom-results]]
before running the scoped test.
