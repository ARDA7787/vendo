# E8 live proof — wave 3, multi-party (plan §6, build contract §9)

Captured 2026-08-01/02 on branch `rebuild/wave3-stage`, against a **production
build** of `apps/demo-bank` (Maple) at `http://localhost:3121`, driven by a real
headless Chromium (Playwright) in **two isolated browser contexts** — one per
signed-in person, both real Auth.js sign-ins through Maple's own login form.

| | |
| --- | --- |
| Yousef Helal | `yousef@maple.com` · subject `vendo-demo` · org `maple` **admin** |
| Mia Nakamura | `mia@maple.com` · subject `maple-mia` · ordinary member of `maple` |

**Posture.** `MAPLE_STORE=local` (explicit local PGlite store — the adapter rule
means it beats the key), `VENDO_API_KEY` set to a placeholder so the §9.6
`multiParty` gate is on (the flag is filled from `cloudKeyOptions() !== undefined`
at `packages/vendo/src/server.ts:2048` — exactly what `orgs-e8.test.ts:68` stubs),
a **real** `ANTHROPIC_API_KEY` so document edits run through the real model,
`MAPLE_DEMO_PASSWORD` for the two logins, `VENDO_TICK_SECRET` so schedules can be
fired on demand, `DEMO_AUTOLOGIN` unset. `next dev` still wedges in this worktree
(lane G's finding); `next build` + `next start` serve normally.

**Apps.** New-app generation against Maple's catalog is a known engine failure
(#631) and the boot log reproduced it again, so the three E8 apps were **seeded
through the records door** — the same way `packages/vendo/src/orgs-e8.test.ts:108`
seeds — and every multi-party action below (promote, share, revoke, fork, enable,
edit, adopt) went through the real product. No source was modified for this proof.

## Result

| # | Scenario | What I did | What happened | Evidence | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | Promote → both see ONE living app | Yousef: Apps tab → **Share** on *Team pulse* → typed `org:maple`, level *Can view* **[A1]** → **Share** (the dialog promotes first, then grants) | Dialog: *"Moved into **Maple Bank**."*; grants become `org:maple:viewer` + `user:vendo-demo:owner`, `personal:false`. Mia's Apps tab now lists *Team pulse* — the **same app id** `app_e8_pulse`, `level:"viewer"`. Before the share her `GET /apps/app_e8_pulse` was **404** (existence masking). | `01a`, `01b`, `01c` | **PASS** |
| 2 | Viewer can't edit, is offered a FORK, fork works | Mia clicked **Remove** on the team's app (accepted the native confirm) | 403 `forbidden` → the consumer-voice offer renders: *"I can't change the team's copy — but I can make you your own."* with **Make me my own copy** / **Never mind**. Clicking it produced `app_4539e217…` — `forkedFrom:"app_e8_pulse"`, in **her** space (`level:"owner"`, `personal:true`, **zero** grants: grants never travel). | `02a`, `02b` | **PASS** |
| 2b | Viewer cannot roll the app back (undo is editor-only, list stays viewer) | Mia: `GET /apps/app_e8_pulse/history` then `POST …/history {"op":"undo"}` | List **200**; undo **403** `forbidden — editor access is required for app_e8_pulse`. | (API — no undo UI exists, see finding F3) | **PASS** |
| 3 | Revoke mid-session: reads age, the next write fails on live rows | Yousef shared *Desk ledger* with `user:maple-mia` at *Can edit* **[A1] [A2]**; Mia **opened** it; Yousef then hit **Remove** on Mia's row in the Share dialog | Grants → `[]`. Mia's **already-open view keeps rendering** (`03c`). Her next writes fail against live rows: `POST …/edit` **404**, `POST …/history {"op":"undo"}` **404**, and the app is gone from her fresh list (`03d`) — masked, because she is no longer even a viewer. | `03a`–`03e` | **PASS** |
| 4 | An org-shared app's per-user data stays separate | Yousef moved *Desk ledger* into the org (`team:maple/support`, *Can view*) **[A1]**; both people opened the **same app id** | One document, one id, `personal:false` — and each person's own row on screen: Yousef sees *Yousef Helal / yousef@maple.com*, Mia sees *Mia Nakamura / mia@maple.com*. The app's query resolves per caller through the ordinary tool pipeline. | `04a`, `04b`, `04c` | **PASS** (see F5 for the half this does not cover) |
| 5 | Sponsor invalidated → adoption card **in the app** → adopt → runs continue as the adopter | Mia enabled the automation (sponsorship minted under her), approved its standing access, a real run fired; Yousef then edited the app (scenario 6), which paused it; Yousef opened the app, pressed **Take it on**, approved the standing access, and the schedule fired again | Card renders inside the open app: **PAUSED AUTOMATION · "Weekly transaction sweep ran with Mia Nakamura's access" · "It changed after Mia Nakamura allowed it, so it is paused. Take it on and it runs with yours instead." · Reads: List transactions · limit 5 · [Take it on]**. After adopting, the automation reads *"Runs with **Yousef Helal's** access"* and the next tick produced `run_56b428dc…` **ok**, 1 step ok. Run history shows the whole arc: **ok (Mia) → error/blocked → ok (Yousef)**. The away tool-call appears in Yousef's audit feed at `06:00:22`, Mia's earlier one in hers at `05:54:36`. | `05c`, `05e`–`05l` | **PASS** (with F1 — the enable had to be started over the wire) |
| 6 | Third party edits a sponsored app → sponsorship invalidated, the automation stops | Yousef (not the sponsor) opened the app on `/vendo/apps` and used the **Edit** box: *"change the heading to say 'Desk transaction sweep'"* — a real model edit that persisted | Next tick did **not** run the automation: `run_61224042…` `status:"error"`, `error.code:"blocked"`, **zero steps**, summary *"stopped: Weekly transaction sweep changed after Mia Nakamura allowed it — anyone who can edit this app can take it on"*. It stopped **before** any tool call, and never ran under the old sponsor. | `06a`, `06b`, `06c`, `05l` | **PASS** |
| 7 | (adversarial) The adoption card is editor-only | Mia — a third party to the *new* sponsorship — edited the app (pausing it again); with `org:maple` at *Can edit* her open payload carried `adoption.reason:"edit"`. Yousef then dropped `org:maple` to *Can view* | Viewer Mia's open payload has **no** `adoption` key and her open app shows **no** card (`07b`), while the owner's payload still carries it. Presence of the card *is* the permission check. | `07a`, `07b` | **PASS** |

Baseline shots `00-*` show both people signed in on the workspace before anything
was shared, and `/api/vendo/status` asserting memberships from Maple's own tables
(`admin:true` for Yousef, `false` for Mia) — stored nowhere.

## Which half was UI, which was API

Everything decisive was UI. The exceptions, stated plainly:

- **`POST /api/vendo/tick`** (with `VENDO_TICK_SECRET`) fired the schedules. There
  is no "run now" button, and waiting for a cron would not have made it more real.
- **Undo** (scenario 2b) is API-only because **no undo control exists in any UI**
  (finding F3).
- **The first enable** of the org automation was `POST /automations/app_e8_sweep/enable`
  because the Automations tab does not list org-held automations (finding F1). Every
  later automation step — the standing-access approval, the adoption, the second
  approval, run history — was clicked in the browser.
- Grant/level assertions quote `GET /apps/:id/grants`, read from inside each
  signed-in page (same session, same wire the UI uses).

## Findings

**F1 — an org-held app's automation is listed for nobody, so the Share dialog's own
promise is unreachable in the UI.** — **FIXED, see [A3]** `list` in
`packages/automations/src/engine.ts:1475-1478` fetches app rows by
`refs: { subject: ctx.principal.subject }` and keeps only rows whose subject equals
the caller. A promoted app's subject is the **org id** (§9.5), so after a promote the
automation vanishes from every member's Automations tab — including the org admin's
and the owner's (`05d`). The only later path back in is `sponsoredElsewhere`
(`engine.ts:1484-1495`), which requires an **active sponsorship you already hold**.
Meanwhile promote deliberately disarms the automation
(`packages/apps/src/runtime.ts:2387-2398`) and the dialog says so — *"Its automation
turns off in the move … it stays off until someone turns it back on"* — but nobody
can turn it back on from the UI. Enabling over the wire works (editor-gated) and
then the row appears for the sponsor only. Suggested shape: union the subject query
with apps the caller can edit in an asserted org.

**F2 — once a sponsorship is invalidated, the paused automation disappears from the
sponsor's Automations tab too.** — **FIXED, see [A3]** Same `list`: only `status === "active"` sponsorships
pull a non-owned app in (`engine.ts:1487`). After the third-party edit, Mia's card
was gone (`06c`) and `GET /automations` returned `[]` for her. The adoption card on
the app is then the only surface that mentions the paused automation anywhere — fine
by design for *asking*, but a person who enabled something and wants to know why it
stopped has nowhere to look.

**F3 — no UI anywhere calls app history.** `useApp().history.{list,undo}` exists
(`packages/ui/src/hooks/use-app.ts:71-81`) and the wire route is live, but no
component mounts it. The late fix that made `undo` editor-only is correct and
enforced server-side (`packages/apps/src/runtime.ts:2674-2686`); there is simply no
button for anyone, viewer or editor, so "the list stays viewer" is currently a
property of the API only.

**F4 — the fork offer is reachable from exactly one control.** — **FIXED, see [A4]** `during(action, appId)`
is passed an `appId` only by **Remove** (`packages/ui/src/chrome/vendo-page.tsx:226-233`);
Fork and Create call it without one, and `VendoPage`'s app view has no edit control at
all. So a viewer meets the fork offer by trying to *delete* the team's app, not by
trying to *change* it. On `/vendo/apps` the editor-gated **Edit** box returns the same
403 but renders it as a bare alert with no offer. The E8 line reads "a viewer cannot
edit and is offered a fork"; what ships offers the fork on a different verb.

**F5 — the per-user store partition (`vendo_state`, keyed `appId:subject`) is still
not browser-provable.** Scenario 4 proves the property that is visible to a person:
one org-held document, each caller's own rows, resolved per request. But nothing
persists app state from the browser in this demo — the jail's `vendo.setState` posts
to an `onStateChange` seam (`packages/ui/src/tree/renderer.tsx:613`) that `demo-bank`
does not wire to storage, and no wire route reads or writes `vendo_state`. That slice
stays proven by `packages/vendo/src/orgs-e8.test.ts:333`, as lane G already recorded
for §9.8.

**F6 (cosmetic, host-side) — the account chip shows the wrong initials.** — **FIXED, see [A5]** Signed in as
Mia, the sidebar reads "Mia Nakamura" under an avatar rendering **YH**
(`01c`, `04b`): `apps/demo-bank/src/app/api/profile/route.ts:12-23` overrides `name`
and `email` from the session but leaves `avatarInitials` from the shared demo seed.
Maple's own chrome, not Vendo.

**Not a product finding, recorded for the next person:** I corrupted the PGlite store
once by deleting `.vendo/data/.vendo-writer.lock` while a `next-server` child still
held the directory (`pkill -f "next start"` does **not** kill the child). The store's
own message named the cause and the fix exactly; the run was restarted on a fresh
store. Stop both processes, never the lock.

## Annotations — what has changed since the run (added 2026-08-02)

The run above is a faithful record of the product **as it stood when the shots
were taken**. Fix rounds landed after it, so these entries no longer describe
what ships. Nothing below is re-shot: the screenshots are the old behaviour, and
saying so is the point.

**[A1] The principal is no longer typed anywhere.** Scenarios 1, 3 and 4 name
`org:maple` / `user:maple-mia` / `team:maple/support` because the picker was a
free-text input. It is now a labelled `<select>` — *"Everyone at Maple Bank"*,
*"The support team"*, *"A specific person…"* — with the §9.2 encoding riding
underneath as the option value where nobody reads it
(`packages/ui/src/chrome/share-dialog.tsx`, F12; landed f7deca924, after these
shots). The grants that resulted are unchanged, so every verdict stands; only the
gesture differs.

**[A2] A person-share now asks the host WHO, before anything moves.** Scenario 3
shared with `user:maple-mia` by typing the subject. Typing the subject is exactly
the B1 defect: whatever was typed became the principal, so "Mia" wrote a grant
that matched nobody — after the app had already been promoted into the team. The
dialog now resolves the typed name through the host's own directory (the §9.1
companion `resolvePerson` seam, wired in `apps/demo-bank/src/vendo/server.ts`)
and grants the SUBJECT that comes back; with the seam unset it does not offer the
person option at all. The field reads *"Look them up by name or email"*. Proven
in `packages/ui/test/chrome/share-dialog.test.tsx`,
`packages/vendo/src/orgs-e8.test.ts` ("only the host can name a person") and in a
real browser: `../2026-08-02-wave3-b1/`.

**[A3] F1 and F2 are fixed.** `list` now unions the caller's own apps with apps
they `can(editor)` in an asserted org, so a promoted automation appears for the
members who can act on it, and an INVALIDATED sponsorship no longer hides the
paused row from the sponsor (`packages/automations/src/engine.ts`, landed
858032735 — 25 minutes before this README was committed). Shot `05d` shows the
old empty tab.

**[A4] F4 is fixed.** The workspace now has a **Change** control per app, and a
`forbidden` refusal from it renders the consumer-voice fork offer — the verb the
`forbidden` code was invented for (`packages/ui/src/chrome/vendo-page.tsx`;
proven in `packages/ui/test/chrome/fork-offer-on-edit.test.tsx` and in a real
browser). Shot `02c-viewer-edit-refused-no-offer.png` shows the old bare alert.
That alert also rendered the SERVER's sentence verbatim; the page now speaks the
consumer's voice for every refusal, so no screenshot of a raw error message
(`"app not found: app_…"`, one naming `VENDO_API_KEY`) reflects what ships.

**[A5] F6 is fixed.** `apps/demo-bank/src/app/api/profile/route.ts` derives the
avatar initials from the signed-in display name, so shots `01c` and `04b` show
initials that no longer appear.

**Still open, unchanged:** F3 (no UI anywhere calls app history — verified again
2026-08-02: no chrome component mounts `useApp().history`) and F5 (the per-user
`vendo_state` partition is still not browser-provable in this demo).

## Reproducing

```
pnpm --filter demo-bank build
# server (from apps/demo-bank), production build — next dev wedges here:
MAPLE_STORE=local MAPLE_DEMO_PASSWORD=maple-demo AUTH_SECRET=… \
VENDO_API_KEY=… ANTHROPIC_API_KEY=… VENDO_TICK_SECRET=… \
VENDO_BASE_URL=http://localhost:3121 MAPLE_DIST_DIR=.next \
  ./node_modules/.bin/next start -p 3121
# fire a due schedule:
curl -X POST -H "Authorization: Bearer $VENDO_TICK_SECRET" localhost:3121/api/vendo/tick
```

`MAPLE_DIST_DIR=.next` marks a test boot (`apps/demo-bank/src/instrumentation.ts:18`)
so chip pre-generation does not spend model tokens on a pipeline #631 fails anyway.
