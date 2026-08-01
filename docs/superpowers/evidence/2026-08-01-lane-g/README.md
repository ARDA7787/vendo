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
See `PARKED.md` item 1 for the hosted-store promote gap that follows from this.
