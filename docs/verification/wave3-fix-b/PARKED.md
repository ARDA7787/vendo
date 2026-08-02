# Wave-3 fix agent B — parked, with evidence

## F25 — the adoption card cannot appear on a SERVED (`ui === "http"`) app

**Status: parked, not fixed. The fix is not local to `open.ts`; it is a surface
change across three files this lane does not own.**

The finding is real and reproduces: `packages/apps/src/open.ts` returns at the
served branch before the venue-state spread, so a stopped automation on a shared
served app waits forever.

### Why it cannot be fixed here

A served app's open surface has nowhere to put the card, and nothing on the
client renders one:

- `packages/apps/src/runtime.ts:361-373` — `OpenSurface` is a closed union; the
  served arm is exactly `{ kind: "http"; url: string }`. No payload, no
  additive slot.
- `packages/ui/src/wire-types.ts:29` — the client's copy of the same union, same
  shape.
- `packages/ui/src/tree/frames.tsx:153` — `AppFrame` renders a served surface as
  a bare `<iframe src={url}>`. There is no Vendo-rendered chrome around it to
  hang a card on.
- `packages/ui/src/tree/renderer.tsx:580` — the card is read off the TREE
  (`tree[ADOPTION_VENUE_KEY]`) inside the payload walk, which a served app never
  enters.

So spreading venue keys onto `{ kind: "http", url }` in `open.ts` would persist
nothing anyone can render: the wire serializes a field the client type does not
declare and `AppFrame` ignores.

### What a real fix needs (all outside this lane's ownership)

1. `packages/apps/src/runtime.ts` — widen the served arm, e.g.
   `{ kind: "http"; url: string; venue?: Record<string, unknown> }` (Agent A).
2. `packages/ui/src/wire-types.ts` + `packages/ui/src/tree/frames.tsx` — render
   the card ABOVE the iframe for the served arm (UI lane).
3. `packages/apps/src/open.ts` — one line, once a slot exists (this lane).

Recommendation: hand (1) and (2) to the owners as one small follow-up; §9.8 is
the section that already says an org-owned served app is a first-class shared
surface, so the ask belongs on it.

## Observed, not fixed (outside the assigned findings)

- `packages/apps/src/history.ts:179` — `undo()` writes the app row directly
  (`store.records("vendo_apps").put`) instead of going through `persistEdit`, so
  a third party rolling the app back does NOT ring `onDocumentEdit` and does NOT
  invalidate the sponsorship. §9.9's choke-point claim ("the ONE choke point
  every document edit passes through") is therefore not true of undo.
- `packages/apps/src/access.test.ts:366-382` — the `onDocumentEdit` choke-point
  test is vacuous: neither `inClient.approve` nor `schedule()` reaches
  `persistEdit` (both use `updateAppDocument` → `updateAppRow`), and the single
  assertion is `seen.every(...)` over an array that stays EMPTY, which passes.
- `packages/automations/src/engine.ts:1776-1790` — `emit` finds host-event
  automations by `refs { subject: principal.subject }` and re-checks
  `row.subject === principal.subject`, so an ORG-owned host-event automation can
  never be fired by any member's event. Same class as E8-F1, but it is a design
  question (whose event fires an org automation?), not a mechanical fix.
