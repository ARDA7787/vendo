# Parked — wave-2 E-proof fix round

Two items. Neither blocks the six findings this round fixed (D1, D4, D5, D6);
both are decisions rather than mechanics, so they are recorded with evidence
instead of being taken unilaterally.

## 1. A body-less `DELETE` still requires `content-type: application/json`

**Where it came from:** the E-proof's operational notes —
"`DELETE /api/vendo/grants/:id` requires `content-type: application/json` on a
body-less request or answers 400 `content-type must be application/json`.
Correct per the CSRF floor, awkward for a caller with no body."

**Classified: it is the ROUTE, not the client.** The gate is global, not per
route — `packages/vendo/src/server.ts:1250-1258` (`jsonMutationRequired`) returns
true for every `POST`/`PUT`/`PATCH`/`DELETE` outside four raw-path exemptions
(`/apps/import`, `/tick`, `/webhooks/*`, `/box/*`), and
`server.ts:1370-1372` rejects anything whose content-type is not JSON. Nothing
consults whether the request has a body.

Reproduced live against Maple on `:3230`:

```
$ curl -s -X DELETE http://localhost:3230/api/vendo/grants/grt_nope
400 {"error":{"code":"validation","message":"content-type must be application/json"}}

$ curl -s -X DELETE -H "content-type: application/json" \
    http://localhost:3230/api/vendo/grants/grt_nope
404 {"error":{"code":"not-found","message":"Grant grt_nope was not found"}}
```

The header alone is the difference: with it the route is reached and answers
honestly.

**Why it is parked and not fixed.** The gate IS the CSRF floor. Its protection
comes from the fact that a cross-site HTML form can only send
`application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`, so
demanding JSON blocks the simple-request CSRF path. The argument for relaxing it
on `DELETE` is that an HTML form cannot emit `DELETE` at all (the `method`
attribute takes only `GET` and `POST`), so a cross-origin `DELETE` must come from
`fetch`/XHR and is gated by a CORS preflight the server never approves — which
would make the content-type requirement redundant *for that method*.

That argument is probably right, and it is still a change to a security floor
that applies to every `DELETE` route on the wire, not a mechanical fix. It wants
a deliberate decision and a sweep of the `DELETE` surface, which is more than
this fix round's mandate. Nothing is broken in the meantime: sending the header
on a body-less `DELETE` works, so the cost today is caller ergonomics only.

**Recommendation:** relax `jsonMutationRequired` for `DELETE` specifically (not
for `POST`/`PUT`/`PATCH`), in a change that also states the CORS-preflight
reasoning in the code and adds a redteam case for a cross-origin `DELETE`.

## 2. `vendo()` has no workspace-file tool, and `workspaceBash` has zero callers

**Where it came from:** the E-proof's parked E3 cell — "same app edited by
`vendo()` and `claudeCode()` → byte-identical stored `app.vendo`" was recorded
UNPROVABLE AS WRITTEN because `vendo()`'s live loadout has no bash and no
read/write/edit, so a generative `vendo_apps_edit` and a bash `sed` cannot be
byte-equal in principle.

**Classified: CONTRACTED-AND-DROPPED, at the decomposition level.** The
capability was built and the projection was never assigned to anyone.

- The design's hands table REQUIRES it. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md:215-233` gives
  in-process harnesses "workspace tools + in-process bash (§8)" with
  `edit(file, old, new)`, and `:184-185` names **workspace** (read/write/edit/ls/grep)
  as one of the four tool families. `:189-192` pre-empts reading the "no
  code-execution tool" cut as covering it.
- The store half was built and verifier-mandated.
  `packages/store/src/workspace-bash.ts:107` (`workspaceBash()`) landed as lane-B
  verifier finding N6, and its own doc comment names the consumer that never
  arrived: the bash interpreter stays "a dependency of whoever actually runs it
  (`@vendoai/harnesses`)".
- No lane was told to wire it. Lane B's acceptance stops at a store-level
  capability — "In-process bash over the façade works: grep/sed a workspace file
  through just-bash with zero sandbox"
  (`docs/superpowers/lanes/2026-07-30-wave1-lane-b-workspace.md:71`), satisfied by
  `packages/store/src/workspace-bash.test.ts`. Lane D owns tool projection and
  its build list (`...lane-d-tools-consent-store.md:28-30`) omits the workspace
  family entirely. Lane E inherited E3 as an acceptance criterion
  (`...wave2-lane-e-claude-code.md:136-139`) without owning the `vendo()`-side
  files needed to satisfy it.
- Nothing defers it: it is absent from the build contract's §8 wave-1 cut list
  (`2026-07-30-build-contract.md:441-447`), no amendment touches it, and §8's
  own clarification at `:463-467` ASSUMES the tools exist ("Vendo-authored tools
  (the vendo verbs, `ask_user`, workspace tools) carry a hand-written, reviewed
  `risk`"). No PARKED record anywhere has ruled on it.

Tally, verbatim: `workspaceBash` has **0** production callers, 2 re-exports
(`packages/store/src/index.ts:47`, `packages/store/src/postgres.ts:71`), 1 test
file, 0 docs outside the E-proof cell. `packages/harnesses/src/vendo.ts` never
references `turn.workspace` at all.

**Why it is parked and not fixed.** The fix round's rule was "implement only if
it was contracted and dropped, and then it is a small projection wiring". The
first half holds; the second does not. Wiring it means a NEW public tool family
— read/write/edit/ls/grep plus in-process bash — and each tool needs a
hand-written reviewed `risk` label per contract §8, a registry, descriptor
hashes, guard/audit coverage, export-surface entries, and `turn.workspace`
plumbing into `vendo.ts` where none exists today. It also lands in
`packages/vendo/src/server.ts:2075-2116`, which lane E's contract flags as
"lane F owns it this wave — ASK before touching". That is a lane, not a wiring
change.

**Consequence to carry forward, stated plainly:** E3's headline invariant — "a
different harness sees the identical workspace" — remains UNPROVEN on the
`vendo()` side, and will stay unprovable as written until the workspace family
exists. The `claudeCode()` half of E3 is proven (kill-mid-turn, mid-turn
skeleton, sync-back).

**Recommendation:** one follow-up lane, owning the workspace tool family end to
end: the six tool descriptors with reviewed risk labels, the registry that
equips them for in-process harnesses, `workspaceBash` finally given its caller,
and E3 re-run to the byte-identical assertion as originally written.
