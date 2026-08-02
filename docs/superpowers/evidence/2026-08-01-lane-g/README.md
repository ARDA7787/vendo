# Lane G — browser evidence (wave 3, orgs + `can()`)

Captured 2026-08-01 against the **production build** of `demo-bank` (Maple) on
`http://localhost:3118`, driven by a real Chromium in an isolated Playwright
context, two real signed-in users. `next dev` in this worktree accepts
connections and then never routes a request (no compile line, no response in
240s) — an environment fault, not a code one; `next build` + `next start` serve
the same app in ~30ms, so the proof runs there.

| Shot | What it proves |
| --- | --- |
| `01-workspace-yousef.png` | Yousef Helal signed into Maple, the embedded workspace live at `/vendo/workspace`. |
| `02-account-switcher-real.png` | E8's switcher is real: one entry per seeded staff member (Yousef · Current, Mia Nakamura), replacing the "Demo only" stub. |
| `03-apps-tab-yousef.png` | The apps surface with a **Share** button on every app — the new §9.2–§9.6 door. |
| `04-share-dialog-owner.png` | The Share dialog open on an org app: it read the caller's level through `GET /apps/:id/grants` and says "Nobody else yet — it's just you." |
| `05-share-cloud-required.png` | §9.6 live, the RED half: a keyless share is refused with the wire's own actionable sentence — *"sharing needs Vendo Cloud: set VENDO_API_KEY (or pass a hosted store) — apps you own alone keep working without it"*. |
| `06-apps-tab-mia-masked.png` | Mia Nakamura, an ordinary member of the same org, does NOT see Yousef's app (existence-masking, §9.4) while the demo's own seeded apps still list. |

## Fix round (2026-08-01, verifier findings G1–G17)

Same setup, same production build, `http://localhost:3119`.

| Shot | What it proves |
| --- | --- |
| `07-workspace-after-fixes.png` | The workspace still boots clean after the fix round. |
| `08-apps-tab-after-fixes.png` | The apps surface unchanged: Open · Fork · Share · Remove. |
| `09-share-dialog-personal-note.png` | **G11** — the dialog knows the app is still personal WITHOUT being told: `GET /apps/:id/grants` now answers `{"level":"owner","grants":[],"personal":true}` (read off the live response) and the note renders "This is your own copy. Sharing it with a team moves it there…". Before the fix `vendo-page` never passed the prop, so this note never appeared and the promote never fired. |
| `10-share-refused-keyless.png` | **G11 live red-green** — sharing with `team:maple/support` now fires PROMOTE first, and the keyless refusal proves it by name: *"promote needs Vendo Cloud: set VENDO_API_KEY (or pass a hosted store) — apps you own alone keep working without it"*. Before the fix the same click went straight to `share`, so the sentence said "sharing". |
| `11-share-automation-disarm-note.png` | **G6** — on an app that declares a trigger the dialog says it plainly before the move: "Its automation turns off in the move — automations run with a person's access, so it stays off until someone turns it back on." |
| `12-switcher-unconfigured-honest.png` | **G17** — with password login unconfigured (production, no `MAPLE_DEMO_PASSWORD`) the account menu says **Switching unavailable** and the toast names the env var, instead of an inert "Personal" item. |

## Fix round 2 (2026-08-01, verifier findings R2-1 … R2-8)

| Shot | What it proves |
| --- | --- |
| `13-share-dialog-first-read-in-flight.png` | **R2-3** — with the grants read held open (Playwright route delay), the dialog says **"Loading…"**. It used to say "You don't have access to this app." on every open, because `null` is also what the hook holds before the first answer. |
| `14-share-dialog-first-read-answered.png` | The same dialog once the read answers: the owner gets the personal-copy note and the share controls. |

R2-1's blocker is a concurrency bug, so its proof is a test, not a shot:
`packages/vendo/src/orgs-e8.test.ts` "two simultaneous promotes: one wins, and
the LOSER undoes nothing of the winner's" over the real composition, plus
`packages/vendo/src/promote-app.test.ts` for the interleavings a wire test cannot
schedule. Both revert-checks are recorded in `PARKED.md`.

## The §9.1 seam, proven end to end in the browser

`GET /api/vendo/status` as Yousef, over the live server:

```json
{"posture":"rules+judge","version":"0.5.0",
 "memberships":[{"org":"maple","display":"Maple Bank","teams":["support"],"admin":true}], … }
```

That answer comes from Maple's OWN user table (`mapleAuth.memberships`), is
resolved once per request, and is stored nowhere. The Share dialog turns it into
consumer-voice options with no Vendo org chart involved — read straight off the
rendered `<datalist>`:

```
org:maple        => "Everyone at Maple Bank"
team:maple/support => "The support team"
```

## What the keyless demo deliberately cannot show

Writing a grant needs a Cloud key (§9.6), and `demo-bank` leaves its store slot
unset, so a key would also swap in the hosted store. The grant-WRITE half is
therefore proven over the real composition in
`packages/vendo/src/orgs-e8.test.ts` instead — real `createVendo`, real
`appAccess`, real wire routes, two principals — covering all seven E8 slices
including promote, the 403 fork offer, revoke against live rows,
subject-partitioned app data, and the one-ok-one-conflict `/orgs` commit pair.
See `PARKED.md` item 1 — the hosted-store promote gap that follows from this was
ruled BYO-store-only on 2026-08-01 and is closed.

## §9.8 (served org apps) — not browser-provable in this demo

The proxy needs a served (layer-3) app, which needs `experimentalServedApps` AND
a real sandbox provider; `demo-bank` leaves both off. It is proven instead at two
levels: `packages/apps/src/served-orgs.test.ts` (open() routes org apps to the
proxy and leaves personal ones alone, `serve()` re-checks on live rows, only the
payload crosses the skin, and a refused caller never costs a machine) and
`packages/vendo/src/orgs-e8.test.ts` §9.8 block (the mounted route admits a
granted viewer and masks a stranger — verified discriminating by unmounting the
route and watching the pair go red).
