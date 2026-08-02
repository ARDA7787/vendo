# B1 live proof — a person-share names a real person, or nothing happens

Captured 2026-08-02 on branch `rebuild/wave3-stage`, against a **production
build** of `apps/demo-bank` (Maple) at `http://localhost:3122`, driven by a real
headless Chromium (Playwright). Signed in as **Yousef Helal**
(`yousef@maple.com`, subject `vendo-demo`, org `maple` admin) through Maple's own
login form.

**Posture.** `MAPLE_STORE=local` (explicit local PGlite store — the adapter rule
means it beats the key), `VENDO_API_KEY` set to a placeholder so the §9.6
`multiParty` gate is on, `MAPLE_DEMO_PASSWORD` for the login, `MAPLE_DIST_DIR=.next`.
Apps seeded through the records door (new-app generation against Maple's catalog
is engine failure #631, as at E8); every sharing action below went through the
real product. Grant/level assertions quote `GET /apps/:id/grants` read from inside
the signed-in page — the same wire the dialog uses.

## The defect

The share dialog's person field asked for "their name or email at work", encoded
whatever was typed VERBATIM as the subject, and wrote `user:<that string>`.
Nothing resolved it, so the grant matched nobody — and because this wave also
made sharing imply promote, the app had **already been moved into the team** by
the time the useless grant landed.

## Result

| # | What I did | What happened | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Share on *Team pulse* (personal) → picker → **A specific person…** → typed `mia` → *Can view* → **Share** | The field reads *"Look them up by name or email"*. Maple's own roster resolved `mia` → subject `maple-mia`. Dialog: *"Moved into **Maple Bank**."* then *"Shared with **Mia Nakamura**."* Grants: `user:maple-mia` viewer + `user:vendo-demo` owner, `personal:false`. The grant is for the **resolved subject**, never for what was typed. | `00`, `01`, `02`, `03` | **PASS** |
| 2 | Share on *Desk ledger* (personal) → **A specific person…** → typed `Mia from the other bank` → **Share** | *"We couldn't find Mia from the other bank here. Check how it's spelled, or hand them a copy of the app instead."* The app is **still personal** — the dialog still says *"This is your own copy. Sharing it moves it into your team"* — and `GET grants` answers `{grants: [], personal: true}` **before and after**. Nothing moved. Nothing was written. | `04` | **PASS** |
| 3 | Same workspace with a host that wired NO directory | The picker offers *"Everyone at Maple Bank"* and *"The support team"* and **no person option at all**. Teams and orgs are untouched by the absence. | `05` | **PASS** |
| 4 | Yousef removed *Rate watch* in one tab, then clicked **Remove** on it in a second, stale tab | The page says *"This app isn't available any more."* It used to render the wire's own sentence — `app not found: app_b1_stale` — verbatim. | `06` | **PASS** |

## Which half was UI, which was API

Everything decisive was UI. Two notes, stated plainly:

- **Scenario 3** is the one place a response was intervened on: the seam is read
  at composition, so a single running server cannot be both wired and unwired.
  That context intercepts `GET /api/vendo/status` and strips `namesPeople` —
  exactly what an unwired host answers. The **server** half (the flag absent, and
  `POST /apps/:id/grants/resolve` answering `501`) is proven over the real
  `createVendo` composition in `packages/vendo/src/orgs-e8.test.ts`
  ("§9.1 companion: only the host can name a person").
- Grant and `personal` assertions are `GET /apps/:id/grants` read from inside the
  signed-in page, because no UI prints a principal — which is the point of F12.

## What is NOT proven here

- **The refusal when the lookup is not set up at all** ("Sharing with one person
  isn't set up here — you can share with a team, or hand them a copy"). It needs
  a host that offers the option while wiring no seam, which no shipped
  composition does; it is pinned in
  `packages/ui/test/chrome/share-dialog.test.tsx` and the wire's `501` in
  `packages/vendo/src/wire/apps.resolve-person.test.ts`.
- **The store-door half of B1** — that an unparseable principal is refused
  identically on Postgres and on the hosted store — is not browser-shaped:
  `packages/vendo/src/app-access-door.test.ts` proves it over a real
  `hostedStore` and asserts the console never sees the write.

## Reproducing

```
pnpm --filter demo-bank build
node docs/superpowers/evidence/2026-08-02-wave3-b1/b1-seed.mjs   # server DOWN: PGlite holds a writer lock
# from apps/demo-bank:
MAPLE_STORE=local MAPLE_DEMO_PASSWORD=maple-demo AUTH_SECRET=… \
VENDO_API_KEY=… VENDO_BASE_URL=http://localhost:3122 MAPLE_DIST_DIR=.next \
  ./node_modules/.bin/next start -p 3122
node docs/superpowers/evidence/2026-08-02-wave3-b1/b1-browser.mjs
```

Both scripts are committed beside the shots (`b1-seed.mjs`, `b1-browser.mjs`) so
the run is repeatable rather than described.

`MAPLE_DIST_DIR=.next` marks a test boot (`apps/demo-bank/src/instrumentation.ts`)
so chip pre-generation does not spend model tokens. No `ANTHROPIC_API_KEY` was
needed: nothing in this proof asks the model for anything.
