# Lane CLOSE — internal-only door mode (door-internal)

**Worktree:** `/Users/yousefh/orca/workspaces/flowlet/doorint` · branch `rebuild/door-internal` · base `31ddb2afd`
**Date:** 2026-08-02 · **Never pushed, no PR, no merge.** Landing is the orchestrator's job.
**Fix round 1** (independent check, FAIL): `internal: true` was not
authoritative (§2), a live misconfiguration went silent (§2), and the tool
door's dev learned origin was Host-poisonable (§3).
**Fix round 2** (§9): a round-1 claim about route binding was REFUTED — its own
learned base was leaking the caller's session cookie and bearer to a spoofed
Host. Fenced with the same predicate. Each defect was pinned red first.

---

## 1. The verdict — `harness: claudeCode()` now needs nothing, and shows nobody anything

`createVendo({ harness: claudeCode({ machine: "local" }) })` is the entire
composition. No `mcp`, no `oauth`, no `VENDO_BASE_URL`. The agent runs the
product's real tools, and an outside agent walking up to the same public origin
finds no discovery document, no authorization server, no registration, no
consent page and a 401 that names no way in.

Both halves are live-proven on a real e2b box over a real public tunnel
(`docs/verification/door-internal/live-internal-door-proof.log`, **13/13**) and
on the local leg through a real SDK subprocess
(`live-composed.log`, **5/5**).

`mcp: true` keeps exactly one meaning and did not move: the outside-agent pin
suite and the parity gate are **byte-identical files** — they do not appear in
this lane's diff at all — and both are green.

---

## 2. What shipped, in three pieces

### `internal` on the door (`packages/mcp/src/door.ts`)

Not a disable switch: the outside half is simply **never constructed**. `oauth`
became optional, and the door keeps the protocol server and the host's adapter
(`#oauth` / `#hostOAuth`) present or absent **together** — absent is the whole
of what "internal" means. `handler()` reads that once and hands the request to
`#internalOnly`, so the OAuth endpoints, the four discovery documents and the
connect page are not disabled paths, they are absent ones. The mount answers a
live turn's bearer through the **unchanged** `#handleTurnMcp`, and answers
everything else with `locked()` — a 401 carrying **no `www-authenticate`**,
because a challenge's job is to name the resource-metadata URL a client
registers against and there is none to name.

**`internal` is authoritative** (fix round 1). It decides at construction, and
an `oauth` adapter passed alongside it is **dropped rather than rejected**:
the flag is an explicit opt-in nobody types by accident, dropping fails CLOSED
(the caller gets the locked door they named), and throwing would turn a safe
misconfiguration — one config bag reused for both door shapes — into a boot
crash. Nothing downstream reads `config.oauth` any more; the config is not the
authority.

A door built with neither `internal` nor `oauth` throws at construction. The
type change would otherwise let a full door silently become an internal one.

### The composition rule (`packages/vendo/src/server.ts`)

`Harness.requires` gained `toolDoor` (contract §1 amendment, `packages/core/src/harness.ts`),
and `claudeCode()` declares it on **both** legs. Then:

| host wrote | door |
|---|---|
| `mcp: true` / `mcp: {…}` | the full door, both spaces, today's behaviour byte-identical |
| nothing, harness declares `requires.toolDoor` | the **internal** half, automatically |
| nothing, harness declares nothing | **no door** — the mount 404s, exactly as before |

Unlike `sandbox`, `requires.toolDoor` can never be a boot error: declaring it is
how a harness asks composition for a door, and composition always answers.

### The deletion

`warnNoDoorOnce()` and its branch are gone. The misconfiguration it named — "you
composed `claudeCode()` and forgot to open the door" — cannot exist any more.
**It had no test pins**; `grep -a` across `packages/` found the string only at
its definition and its one call site.

What replaced it (fix round 1) is **narrower and pinned**: `warnNoOriginOnce()`,
for the one case that is still real — a door was composed and there is no origin
to dial it at. Only the LOCAL leg reaches it, because a box refuses outright and
is loud that way. Deleting the old warning without this left a production
`claudeCode({ machine: "local" })` with no `VENDO_BASE_URL` running with none of
the product's actions and saying nothing to anyone.

---

## 3. Where the harness dials — a Host-derived origin, fenced to loopback

The contract said `machine: "local"` "continues to work with no base URL". It did
not, at base — see **`docs/verification/door-internal/PARKED.md`** for the
measured evidence. Left alone, mounting an internal door would have turned two
passing live cases from "runs toolless" into "refuses the turn". So the door
target resolves in three steps, all pinned:

1. **Operator-set base wins**, on both legs, always.
2. **A harness that needs no machine** may fall back to the origin the wire
   itself was reached at — **but only a LOOPBACK one, and only the first that
   qualifies.** This is what makes zero-config real.
3. **A harness that needs a machine is never handed a learned origin.** A box
   holding a live turn credential must not be pointed anywhere a request header
   could name, and loopback is unreachable from a box regardless. With no
   operator base it refuses in the operator's voice — the one deployment gap the
   contract says to keep, unchanged.

**This rule is about the HARNESS's door target, so it applies identically to an
`mcp: true` composition and to an internal-only one.** It is not a property of
the internal door; any composition naming a machine-less `requires.toolDoor`
harness gets it.

**Round 1 closed a real hole here.** The first shipping deferred to route
binding's trust rule (04 §4: learned origins trusted in development). That was
wrong, and Yousef ruled it a defect rather than a posture choice. A request
origin IS the Host header: in `NODE_ENV=development` with no `VENDO_BASE_URL`,
one request carrying `Host: attacker.evil` fixed the origin **process-wide**,
after which the harness sent `Authorization: Bearer vtk_…` and every tool call
to the attacker.

Round 1 then argued route binding itself did not need the same fence. **That
argument was false and is retracted in §9** — route binding's learned base was
carrying the caller's own session cookie and bearer to the attacker, which is a
worse leak than the one being fixed here. Round 2 fenced it with this same
predicate.

The fix is the smallest one that keeps zero-config dev working: the tool door
keeps **its own** learned origin, separate from route binding's, and it is
**loopback-only** (`localhost` / `127.0.0.1` / `::1`) and **fixed by the first
qualifying request**. A non-loopback Host is never a candidate; a second
loopback Host cannot displace the first. Loopback is exactly where a
machine-less thinker's subprocess lives, so nothing is lost. Production and test
still yield `undefined`, unchanged.

And a **local** thinker with no origin at all now **runs** rather than refuses:
nothing was configured wrong, and a subprocess on this machine with no product
actions is the workspace-only assistant that composition has always served — but
the operator now hears about it **once, loudly**, naming `VENDO_BASE_URL`. Round
1 shipped that case silent, which was the second required fix: the box's missing
origin is loud by virtue of refusing, and deleting the old no-door warning left
the local case with no signal at all.

---

## 4. Line counts — measured, and the lane is net-POSITIVE

| production file | before | after | delta |
|---|---|---|---|
| `mcp/src/door.ts` | 1,309 | 1,399 | **+90** |
| `vendo/src/server.ts` | 2,938 | 3,027 | **+89** |
| `harnesses/src/claude-code/index.ts` | 487 | 501 | +14 |
| `core/src/harness.ts` | 157 | 165 | +8 |
| `harnesses/src/claude-code/machine.ts` | 110 | 112 | +2 |
| **total** | **5,001** | **5,204** | **+203** |

Split by kind: **+66 code**, **+132 comment**, +5 blank.

**This misses the contract's "net-negative or ~zero" prediction, and it grew
across both fix rounds** (+118 → +196 → +203: the authority fix, the restored
operator diagnostic, and two loopback fences). Round 2 added **zero** net code —
its fix is one predicate on an existing line; the +7 is the corrected comment.

Reporting the measurement, not the prediction. "Mostly NOT constructing the outside half" is true of the runtime
path and false of the source: nothing was removed to get there, a second entry
leg was added beside the first (`#internalOnly`, `outsideSpacePath`, `locked()`,
`isLoopbackOrigin`, the constructor guard), plus a second door composition and a
three-way URL rule in the umbrella. The only deletion the contract named is 12
lines.

Tests: **+630** — `mcp-door-internal.e2e.test.ts` (373 new lines),
`claude-code-local.test.ts` (135 new, the local leg's first offline coverage),
+107/−3 in `server.test.ts` (the two poisoning pins, the shared `requestFrom`
helper, and the origin move in the wave-1.1 test), +65 in `door.test.ts`, +11 in `claude-code.test.ts`, and +68/−12 in the
composed live suite.

---

## 5. Proofs

Evidence: `docs/verification/door-internal/`.

| # | proof | status | evidence |
|---|---|---|---|
| 1 | Outside-lockout pin suite, written and run **RED first against a full door** | **PASS** | `lockout-pins-RED-against-full-door.log` (**6 of 9 failing**) → `mcp-door-internal.e2e.test.ts` **16/16** |
| 2 | `mcp: true` byte-identical | **PASS** | outside-agent **7/7** · parity gate **7/7** · turn-credentials **11/11**, all three files **absent from the diff** |
| 3 | Live, on an internal-only composition: box over a real tunnel | **PASS (live)** | `live-internal-door-proof.log` / `.json` — **13/13**, re-run after the fix round |
| 3 | Live, on an internal-only composition: local leg + box driver | **PASS (live)** | `live-composed.log` **5/5** · `live-box.log` **7/7**, both re-run after the fix round |
| 4 | Zero-config boot: no warning, working agent | **PASS (live)** | `live-composed.log`, "ZERO CONFIG" |
| 5 | Full gates, twice | **PASS** | §7 |
| R1 | `internal: true` is authoritative even with `oauth` | **PASS** | `door.test.ts` 3 pins, red first (200 / 201 / challenge) |
| R1 | The silent local misconfiguration is loud again | **PASS** | `claude-code-local.test.ts` 2 pins, red first, red-green re-verified |
| R1 | A spoofed Host cannot become the tool-door origin | **PASS** | `mcp-door-internal.e2e.test.ts` 3 attack pins, red first (`https://attacker.evil/api/vendo/mcp`) |

### Proof 1 in full — the red run

The pin file composes `createVendo({ harness: <requires.toolDoor> })` and asserts
absence. It was first run with `mcp: true` + `oauth` spliced into that same
composition, i.e. against a **full** door, where 6 of 9 fail:

```
× no discovery: every document that would tell a client this door exists is 404
× no authorization server: register, authorize, token, revoke, federate and the connect page are all 404
× the ONLY way an outside bearer can exist — register → authorize → token — cannot even start
× no bearer at the mount is a FLAT 401: no challenge, so nothing names a place to sign in
× an invented bearer is the same flat 401 — including one shaped like a turn credential
× the product never advertises an MCP surface: `mcp: true` remains the ONLY thing that says so
```

The three that passed red are the CONTROL (a turn-bearing call works at a full
door too — that is the point), the unauthenticated `tools/list` (a full door 401s
that as well), and "a harness that needs no door gets NO door" (true before and
after, which is what makes it worth keeping).

### Proof 3 in full — 13/13 over the public internet, with `mcp` nowhere in sight

`live-internal-door-proof.mjs` is door-ctx's live proof with **one** thing
changed: the composition is `harness: claudeCode({ sandbox: e2bSandbox(…) })` and
nothing else. A real e2b box on template `h5pf20fap7ows6io81kr`, a real Claude
Agent SDK session, a real cloudflared quick tunnel:

- the box's read executed host-side, `venue: chat · presence: present · ok · rule`;
- the model answered with the host's own data (`inv_7781`);
- the transcript mirror carried the call;
- a parked WRITE put a card on the **public approvals queue mid-turn**, the turn
  waited, the tap **executed** it — one `ok` row, `decidedBy: grant`;
- a file the box wrote was readable through the host's workspace door;
- an UNATTENDED turn: `away`/`automation`, nothing executed;
- a credential outside a turn is 401;
- **check 7, new:** every outside path on that same public origin is 404
  (four discovery documents, `/authorize`, `/connect`, `POST /register`), and the
  mount's 401 carries no `www-authenticate` at all.

### Proof 4 in full — the headline, live

`live-composed.log`, "ZERO CONFIG": `NODE_ENV=development`, no `mcp`, no `oauth`,
no `VENDO_BASE_URL`. The turn is driven over the **real loopback URL** rather
than through `vendo.handler`, because the origin the wire is reached at is the
whole mechanism. The model ran `maple_invoices_list` host-side; the same origin
served `404` for the server card and a challenge-free `401` at the mount.

"Boots with no warning": neither live log contains `[vendo] claudeCode()`
anything. The two `[vendo]` lines that remain are pre-existing and named in the
door-ctx close note — the `model:` deprecation and "zero live host tools" (tools
added via `actions.add()` after construction).

### The three round-1 pins, red first

Each was written before its fix and run against the shipped code, so each red
run reproduces the checker's own measurement.

**R1 · `internal: true` is authoritative** (`packages/mcp/src/door.test.ts`).
Red, with `internal: true` AND an oauth adapter passed together:

```
× serves NO discovery … → expected 200 to be 404
× registers NOBODY …    → expected 201 to be 404      (a client really registered)
× refuses the mount FLAT … → expected 'Bearer resource_metadata="https://pro…' to be null
```

Green after the fix: `door.test.ts` **86/86** (was 83).

**R1 · the silent local misconfiguration** (`claude-code-local.test.ts`, new).
Red: `expected [] to have a length of 1` — the operator was told nothing. Green
after restoring a one-time error. Then **red-green re-verified**: deleting the
`warnNoOriginOnce()` call fails the pin again, restoring it passes. The third
assertion in that block (a reachable door says nothing) passed red, which is
what proves the local machine double is really wired and the turn really ran.

**R1 · Host-header poisoning** (`mcp-door-internal.e2e.test.ts`). Red, exactly
the checker's finding, on both door shapes:

```
× ATTACK: a spoofed non-loopback Host NEVER becomes the tool-door origin
  → expected 'https://attacker.evil/api/vendo/mcp' to be undefined
× ATTACK: a spoofed Host cannot REPLACE an origin already learned, in either order
  → expected 'https://attacker.evil/api/vendo/mcp' to be 'http://127.0.0.1:3000/api/vendo/mcp'
× the SAME rule governs an `mcp: true` composition
  → expected 'https://attacker.evil/api/vendo/mcp' to be undefined
```

Green after the loopback fence: **16/16**. The four boundary cases that passed
red (loopback works, a machine-needing harness gets nothing, production/test
yield undefined, operator base wins) still pass — the fix narrowed the rule
without moving them.

### Round-0 red-green, by weakening the code

- **The door-base rule.** Replacing it with an unconditional
  `?? actionsConfig.baseUrl` fails exactly two pins. Restored → green.
- **`requires.toolDoor`.** Reverting `claudeCode()`'s declaration fails the new
  boot-gate pin (`expected undefined to be true`). Restored → 48/48.

---

## 6. Deviations, and what is not pinned offline

### One live flake, NOT mine, left alone

`§1.3 · turn.state is DURABLE` asserts `expect(second).toContain("5591")` against
the **raw SSE stream**. The model does answer 5591, but often as two deltas
(`"5"`, `"591"`), so the literal never appears. The independent checker saw it
fail 2 of 3 runs and captured a passing stream confirming the behaviour is
correct. The assertion is brittle, not the code. Explicitly **not touched** —
the conductor is tracking it separately. It passed on both post-fix runs here.

### The local leg is now pinned OFFLINE

Round 0 said this could not be unit-tested, because `localMachine()` opens a real
Agent SDK session and the SDK is installed in this repo. Round 1 needed the pin,
so `claude-code-local.test.ts` doubles **`./local.js`** — one module, replaced by
a `SessionMachine` implementing the same port. `claude-code.test.ts` keeps its
no-mocks-of-our-own-code philosophy intact (this is a separate file, and `vi.mock`
is per-file). What is under test is `index.ts`'s branch, not where a workspace
lands. Side effect worth naming: the local leg had **no offline coverage at all**
before this, and now has some.

### `oauth` became optional on `McpDoorConfig`

Required for an outside-serving door, meaningless for an internal one. The
looser type is closed at construction with a `TypeError` naming the fix, so a
full door cannot silently degrade into an internal one — and, since round 1, an
`oauth` passed **alongside** `internal: true` is dropped rather than honoured, so
an internal door cannot silently become a full one either. That was the whole
defect: `internal` was read in one place and the runtime branched on another.

### The learned-origin rule is NOT scoped to internal-only doors

Worth stating plainly because round 0 did not: `doorBase()` governs where any
`requires.toolDoor` harness dials, so the loopback rule applies to `mcp: true`
compositions identically. Pinned as its own case.

### Not done, deliberately

- **No boot gate for `requires.toolDoor`.** Composition always satisfies it, so
  `assertHarnessComposable` is untouched. (This also closes door-ctx's open
  recommendation to make the no-door case a boot gate — the case is gone.)
- **The internal door is handed no `apps`, no `menuTools`, no `theme`.** The turn
  leg reads none of them: a turn's tools, curation and rendering are decided by
  the turn.
- **No loopback listener inside `@vendoai/vendo`.** It would make zero-config work
  for a box too, and it would put `node:http` in a package the portability gate
  keeps Workers-clean.

---

## 7. Gates

From THIS worktree root.

- `pnpm build` ✅
- `pnpm typecheck` ✅ **43/43**
- `pnpm lint` ✅ **6/6**
- `pnpm test --force --concurrency=1` from THIS worktree root, **TWICE**, never
  concurrently with each other or with a build:
  run A **55/55 successful, 0 cached**; run B **55/55 successful, 0 cached**.
  (Tally read, never a piped exit code.) Re-run in full for round 2.

Per-package on run A: vendo **1908** · core 889 · ui 720 · apps 695 ·
actions 572 · bench 525 · corpus-harness 390 · store 381 · harnesses **248** ·
guard 226 · agent 158 · demo-accounting 152 · genui-bench 122 · telemetry 119 ·
knowledge 114 · demo-bank 102 · mcp **90** · automations 87 · demo-template 82 ·
integration 52 · engine 49 · automations-e2e 36 · redteam 21 · mcp-e2e 19 ·
chat-e2e 13 · video-studio 10 · existing-agents 10 · express-host 6 ·
mastra-agent 5 · vendoai 3. **7,807 passing** after round 2 (round 1: 7,805;
round 0: 7,797 — ten new pins across the two fix rounds).

No load-flakes to classify in either round: both runs were clean first time, and
the classes the contract names as not-mine (`harness-system-prompt.test.ts`,
`@vendoai/redteam-e2e`, `@vendoai-fixtures/integration`) were green throughout.

Live, ALL re-run after the fix round: **internal-door tunnel proof 13/13** ·
**composed local 5/5** · **box 7/7** · **mcp-e2e fixture 19/19** (the outside
door, end to end, unchanged).

---

## 8. Unrelated issues noticed, not fixed

- `packages/vendo/src/claude-code-composed.live.test.ts` asserts model answers
  against the **raw SSE stream**, so any token split across two deltas is a false
  failure (§6). Three assertions in that file have the shape.
- `pnpm typecheck` still excludes test files, so a live suite can break with
  43/43 green. Named in the door-ctx close note; still true, still bit nobody
  here only because the suites were run.
- `packages/apps/src/claude-turn.ts` still greps as binary (a raw NUL byte) —
  `grep -a`. `packages/mcp/src/door.ts` does **not**, despite the contract's
  warning.
- `createVendo` still warns "zero live host tools" when tools arrive via
  `vendo.actions.add()` after construction. Cosmetic, pre-existing, fires in
  most of this lane's output.
- A file that GROWS past `WALK_SKIP_BYTES` (8 MiB) inside the box is deleted from
  the store at turn end. Flagged by cc-native and door-ctx, still true, still out
  of scope.
- ~~Route binding's learned base is safe to leave poisonable because a poisoned
  base costs a failed fetch rather than a leaked credential.~~ **That round-1
  claim was FALSE and is retracted** — see §9. It cost a real credential
  exfiltration, and round 2 fenced it.

---

## 9. Fix round 2 — the retracted claim, and the exfiltration behind it

### What I claimed, and what was actually true

Round 1 fenced the tool door's learned origin to loopback and then argued route
binding did not need the same fence:

> a poisoned base there costs a failed fetch rather than a leaked credential

**That is false.** The independent checker measured the opposite, and I
reproduced it before fixing anything. With `NODE_ENV=development`, no
`VENDO_BASE_URL`, and one wire request carrying `Host: attacker.evil`:

```
url:           https://attacker.evil/api/vendo/doctor/present/echo
cookie:        session=the-callers-real-session
authorization: Bearer the-callers-real-token
```

The caller's real session cookie and bearer, to an attacker-named origin, on
every present-mode host tool call after the poisoning request. Same class as the
hole I had just fenced, one subsystem over, with a **worse payload**: the tool
door leaks a turn credential scoped to one conversation; this leaks the end
user's own session.

The mechanism, traced: `onRequestOrigin` learned any origin and set
`baseUrlTrusted = isDevelopmentEnv`; `mayForwardPresentHeaders`
(`packages/actions/src/runtime/registry.ts`) returns that flag directly for a
non-openapi binding, and a `true` there is what puts `cookie` and
`authorization` on the outbound request.

### SCOPE — established as fact, not inference

**`baseUrlTrusted` can pair with a LEARNED origin only when
`process.env.NODE_ENV === "development"` exactly.** Enumerated, not assumed —
every site in the repo:

| site | what it does |
|---|---|
| `server.ts:1791` | `baseUrlTrusted: true` for the **operator-set** `VENDO_BASE_URL`. Never a learned origin, and when it is set the learn branch never runs (`if (actionsConfig.baseUrl === undefined)`). |
| `server.ts:2925` | the learn branch — **the only** place a learned origin can be trusted. |
| `registry.ts:725` | `config.baseUrlTrusted ?? true` — the default for a host calling `createActions` directly with its own base. Not a learned origin. |

`isDevelopmentEnv` is `environment("NODE_ENV") === "development"`, and
`environment()` reads `process.env` only (`wire/shared.ts:267`). Nothing else
sets it; `CreateVendoConfig` has no passthrough.

**So: NOT reachable in a normal production deployment.** NODE_ENV unset (the
common bare-node case) yields `false`, as does `production` and `test`. The
severity is **dev-machine, not live-user** — with one caveat worth stating
plainly: nothing *enforces* that, so a deployment that ships with
`NODE_ENV=development` set (wrong, but a real thing people do) was exposed to
live-user credential theft. That is now closed regardless of NODE_ENV, because
the fence is on the origin, not the environment.

### The fix — one line, one authority

```ts
actionsConfig.baseUrlTrusted = isDevelopmentEnv && isLoopbackOrigin(origin);
```

Reusing the door's own `isLoopbackOrigin` rather than writing a second
predicate. First-wins was already there (`if (actionsConfig.baseUrl ===
undefined)`) and is pinned.

**Only the TRUST is fenced, never the base itself.** Resolving route bindings
same-origin with zero config is what the learner is for, and an untrusted
learned base still resolves — exactly as it already does in production. Fencing
resolution too would have broken zero-config routing for every production
deployment without `VENDO_BASE_URL`, which is a far larger change than the
security fix needs. The residual that leaves is recorded in `PARKED.md`.

### One pre-existing test changed, stated out loud

`09-vendo §2 install-dx wave 1.1: NODE_ENV=development trusts its own learned
origin` taught `https://host.test` and asserted the credentials forwarded — it
was passing *because* of the defect. Its origin moved to `http://localhost:3000`
and its title gained "LOOPBACK". The promise it exists for is unchanged and
still pinned: in development, with zero `VENDO_BASE_URL`, the wire trusts the
origin it was actually reached at — and `next dev` serves localhost. No
assertion was weakened or deleted.

### Red-green

Red, before the fence (the probe output above is from this run):

```
× SECURITY: a spoofed non-loopback Host never becomes the learned base …
  → expected false to be true
```

Green after: `server.test.ts` **123/123**. Re-verified by reverting the single
predicate to `isDevelopmentEnv` — the pin fails again; restoring it passes. The
companion latch pin ("a loopback origin already learned cannot be REPLACED")
passed red, which is what proves first-wins was already sound and that the fix
is the loopback restriction alone.
