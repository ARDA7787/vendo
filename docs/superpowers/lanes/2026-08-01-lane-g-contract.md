# Lane G handoff contract — orgs + `can()` (wave 3)

**2026-08-01, wave-3 orchestrator.** You are a factory builder. Build this
contract to completion in YOUR OWN worktree (path has no spaces; you will be
told it). Branch off `rebuild/cutover` at the base commit you were given.
NEVER push, PR, or merge. Commit locally with clear messages. Seam questions
go to the orchestrator; you never diverge from frozen shapes locally.

## Read first

1. `docs/superpowers/specs/2026-07-30-build-contract.md` — §9 is YOUR shapes
   (9.1–9.8), frozen. §3 (workspace) for what you extend.
2. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md`
   §8 (workspace + permissioning — the LOCKED 2026-08-01 amendments), §11.
3. `docs/superpowers/lanes/2026-08-01-wave3-orchestrator-brief.md` — the six
   locked decisions. Do not re-litigate any of them.

## Locked decisions you implement (violating one fails the lane)

- The host's identity system IS the org: memberships are asserted per
  request/run via the auth-preset callback, NEVER stored as Vendo rows.
- Vendo stores only grants (app → principal → level), written by the Share
  dialog, behind the wired store.
- `can()` is one function, OSS, never key-conditional; share/promote/grant
  writes throw `cloud-required` without a key.
- Closed level vocabulary viewer/editor/owner; org admins are implicit
  owners; effective access = max of grants; fork offer (not bare refusal)
  for viewers; share implies promote; registry stays dead snapshots.
- No console channel into a host's database — you build NOTHING console-side.

## Build list

### 1. Memberships seam (contract §9.1)

- `Membership` type in core; `memberships?` on `HostAuthPreset`
  (`packages/vendo/src/auth-presets/shared.ts:9`), threaded through
  `HostAuthPresetOptions` (`shared.ts:34`) and `composeHostAuthPreset`
  (`auth-presets/identity.ts:167`, one-line return extension at `:199`) so
  all five presets get it. Conformance-kit case in
  `auth-presets/conformance.ts`.
- `RunContext.memberships?: Membership[]` (additive; schema is passthrough).
- Wire: unpack in `createVendo` beside `server.ts:1372-1374`; new `WireDeps`
  field; resolve once per request in `createContextResolver`
  (`packages/vendo/src/wire/context.ts:170` region) and stash on the
  returned ctx. The `kind:"org"`-principal refusal at `context.ts:164-166`
  stays.
- Engine seams: optional `memberships(principal)` on `createAutomations`
  config and `ScheduleEngineConfig` (`packages/apps/src/schedules.ts:99`),
  awaited when building fire contexts (`automations/src/engine.ts:473-480`,
  `apps/src/schedules.ts:357-363`). Threaded at composition
  (`server.ts:1946`, `:2377`).

### 2. Grants + `can()` (contract §9.2–9.4)

- `vendo_app_grants` table: SCHEMA_VERSION 6→7 (`packages/store/src/schema.ts:40`),
  a RESERVED routed collection in `packages/store/src/routing.ts` (copy the
  `vendo_effects` wave-1 pattern — no generic-records fallback), joins
  `ERASE_TABLES` (`erase.ts:17-38`) and `byApp` (`erase.ts:196-215`);
  deliberately absent from anon-adoption (`helpers/subjects.ts`) — comment
  why.
- `appAccess(store)` in `packages/store/src/helpers/app-access.ts` with the
  frozen §9.3 surface. Grant writes audit `AuditEvent.kind:"share"` (type
  exists at `core/src/audit.ts:13`, ZERO producers today — you are the
  first; UI semantics already shipped at
  `ui/src/chrome/activity-semantics.ts:62,113,148`).
- New `VendoErrorCode` member `forbidden` → HTTP 403
  (`core/src/errors.ts:10,20`, `vendo/src/wire/shared.ts:38-50`), thrown
  per §9.4's posture (only to provable viewers).
- Widen the apps runtime: `owned`/`requireOwned`
  (`packages/apps/src/runtime.ts:907-922`) become level-aware via
  `appAccess` — reads need viewer, edits editor, delete/share owner; the
  `not-found` masking posture survives for non-viewers. `list()`
  (`runtime.ts:1933-1946`) unions owned + granted (grants matched against
  ctx memberships). The runtime receives `appAccess` + `multiParty` via
  config; the MCP door (`packages/mcp/src/apps-port.ts`) inherits through
  the runtime — verify with a test, don't duplicate logic.
- Org-app writes: the guarded `vendo_apps` write path
  (`store/src/routing.ts:460-514`) pins `WHERE id AND subject` — for
  org-owned rows the runtime passes the org id as the row subject after
  `can(editor)` passes. Do not weaken the routing guard itself.

### 3. Share, fork, promote (contract §9.5–9.6)

- `promote(appId, orgId, ctx)` on the runtime + wire route: row subject →
  orgId verbatim, workspace rows moved `/user/apps/<id>/** →
  /orgs/<orgId>/apps/<id>/**` (owner + path rewrite, history follows — new
  `WorkspaceRows` operation), owner grant for the promoter, lifecycle op
  `"promote"` (`runtime.ts:1315-1324` enumeration + `apps/src/audit.ts`).
- Fork: `requireOwned` → `can(viewer)` at `runtime.ts:1970`; grants never
  travel (structural — fresh id, own collection; add the test).
- Wire routes inside the `wire/apps.ts` catch-all: `GET/POST/DELETE
  /apps/:appId/grants`, `POST /apps/:appId/promote`. Mind the
  literal-before-catch-all ordering rule (`wire/apps.ts:73-75`). Replace the
  blanket `/orgs` 402 (`wire/misc.ts:155-160`, `wire/approvals.ts` org
  params) ONLY where wave-3 functionality lands; sharing routes themselves
  throw `cloud-required` when `multiParty` is unset (§9.6).
- Client + UI: client methods (`ui/src/client-impl.ts:192-217` region),
  `use-app-grants` hook, a Share dialog in `packages/ui/src/chrome/`
  (follow `grant-set-card.tsx` / `connected-accounts-panel.tsx` idiom:
  pick principal (org/team/user) + level, list + revoke existing grants),
  and the viewer fork-offer render off `forbidden` (consumer-voice: "I
  can't change the team's copy, but I can make you your own"). The fork
  button already exists (`vendo-page.tsx:193`).
- `multiParty` composition fill beside the share/publish seam at
  `server.ts:1936-1940`.

### 4. `/orgs` workspace mounts (contract §9.7)

- Multi-owner façade: `WorkspaceStoreFs` currently binds ONE owner
  (`store/src/workspace-fs.ts:146-153`); add the path→owner resolver and a
  mount set from ctx memberships (`workspaceStore().open` at
  `store/src/workspace.ts:46-49` takes the principal — it now takes the
  ctx/memberships too). Per-app subtree visibility under
  `/orgs/<org>/apps/<appId>/` via `can()`; `/orgs/<org>/policy.json`
  writable only with `admin: true` (lane H reads that file; you own the
  mount rule).
- Per-mount commit policy: `/user` keeps the LWW re-aim loop
  (`workspace-rows.ts:297-341`); `/orgs` = strict CAS returning
  `{status:"conflict", paths}` — the FIRST construction of the conflict
  branch (`core/src/workspace.ts:26`); nothing throws for a lost org swap.
- Widen the hardcodes (all found in recon): hot-path render regex
  (`harnesses/src/render-seam.ts:44`), readdir of `/`
  (`workspace-fs.ts:200,322-325`), EACCES message (`:50-54`), erase
  by-app anchor (`erase.ts:214-222` — add the `/orgs` anchor), plus the
  stale comments at `schema.ts:154-155` and `files-store.ts:10-11`.
- Erase semantics: `bySubject` never deletes org-owned rows; document the
  rule where the code decides it.
- Checkout/commit helpers for sandboxes (wave-2's lane E will consume via a
  seam at integration): export from the store a "visible file set for ctx"
  query and a per-path `can(editor)` commit check — functions only, no
  materialization code (that is lane E's).

### 5. Demo wiring for E8 (small, required)

- `apps/demo-bank/src/vendo/server.ts:21-27`: add a `memberships` callback
  mapping both seeded users (`src/server/users.ts:32-45`) to org `maple`
  (one admin: yousef). Make the account switcher real: replace the stub
  item at `src/components/shell/account-switcher.tsx:57` with one entry per
  `mapleDemoUsers()` posting through the existing `/login` credentials flow.
  Nothing else in the demo changes.

## Seams lane H consumes (build them; H implements the other side)

- The `onDocumentEdit` apps-config hook (§9.9): call it in `persistEdit`
  (`runtime.ts:1235-1291`) after a successful persist, with
  (previous, next, editor subject). 5 lines; H does everything downstream.
- A venue-state slot for H's adoption card: H adds its own file; you keep
  the `venueStateFor` injection point (`runtime.ts:1168` region,
  `inclient.ts:80-98` pattern) composable so a second additive state can
  ride it. If it already composes, do nothing.

## Frozen shapes consumed

Contract §3 (workspace paths, tables, `WorkspaceFs`/`CommitResult`,
`IFileSystem` vendored), §9.1–9.8 (yours). `Principal` stays untouched;
memberships ride the ctx, never the principal.

## Acceptance (all must hold before you report done)

- E8 slices provable locally: two principals with asserted memberships —
  promote → both see one living app; viewer denied edit gets `forbidden`
  and can fork; revoke → reads age, next write/commit fails against live
  rows; per-user app data stays subject-partitioned (test it); two
  concurrent `/orgs` commits to one file → one ok, one
  `{status:"conflict"}` (E3's org slice).
- No key ⇒ grant/promote/share routes throw `cloud-required`; `can()`
  behaves identically keyed/unkeyed given the same rows.
- Every boot/permission gate ships a test that proves it can still FAIL
  (wave-1 law — a red-green pair, not pass-only).
- Full scoped gates green from YOUR worktree: `pnpm build`, then
  `pnpm --filter @vendoai/store --filter @vendoai/apps --filter
  @vendoai/vendo --filter @vendoai/ui --filter @vendoai/automations test`,
  `pnpm typecheck`, `pnpm lint` (dependency-guard: no new sideways edges).
  Do NOT run the full root suite in parallel with other worktrees.
- KNOWN base reds you are not responsible for: 7 tests fail in any
  worktree whose path contains a space (yours won't), and new-app
  GENERATION against Maple's catalog fails ~100% (engine issue #631) — E8
  uses seeded/existing apps, never fresh generation.

## Out of scope (do not build)

Console/org-management UI (different repo; no console channel exists into a
host DB — building one fails the lane) · sponsorship, adoption, org policy
(lane H) · sandbox materialization (wave-2 lane E) · org memory ·
`operator` level or any new level type · conditions/scopes on grants ·
membership persistence of ANY kind · renaming `cloud.ts` share/publish ·
the automations enable-flow consent restructure (automations-pack session).

## Files you own (no other lane touches these)

`packages/store/src/{workspace-fs,workspace,workspace-rows,schema,erase,routing}.ts`,
`packages/store/src/helpers/{app-access,subjects}.ts` ·
`packages/apps/src/{runtime,persistence,interchange,open}.ts` (H gets two
named seams only, via you) · `packages/vendo/src/auth-presets/**`,
`packages/vendo/src/wire/{apps,context,misc,shared}.ts`,
`packages/vendo/src/server.ts` (wave-3 regions) ·
`packages/core/src/{workspace,errors,principal,run-context,audit}.ts`
(additive only) · `packages/ui/src/**` share-dialog + hooks + client ·
`packages/harnesses/src/render-seam.ts` · `apps/demo-bank/**` (the two E8
files). Report anything else you find yourself needing — do not take it.

## Report

When done: branch + final commit hash, what you built, decisions you made
locally (contract rule: not-frozen ⇒ decide + note), test tally
(build/test/typecheck/lint numbers), and anything you believe the contract
got wrong. Sincere claims only — an independent verifier runs after you.
