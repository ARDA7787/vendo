# Lane CLOSE — internal-only door mode (door-internal)

**Worktree:** `/Users/yousefh/orca/workspaces/flowlet/doorint` · branch `rebuild/door-internal` · base `31ddb2afd`
**Date:** 2026-08-02 · **Never pushed, no PR, no merge.** Landing is the orchestrator's job.

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
became optional, and `#oauth` (the `OAuthServer`) is undefined on an internal
door — which is the whole of what "internal" means. `handler()` reads that once
and hands the request to `#internalOnly`, so the OAuth endpoints, the four
discovery documents and the connect page are not disabled paths, they are absent
ones. The mount answers a live turn's bearer through the **unchanged**
`#handleTurnMcp`, and answers everything else with `locked()` — a 401 carrying
**no `www-authenticate`**, because a challenge's job is to name the
resource-metadata URL a client registers against and there is none to name.

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

`warnNoDoorOnce()` and its branch are gone (−12 in
`packages/harnesses/src/claude-code/index.ts`). The misconfiguration it named —
"you composed `claudeCode()` and forgot to open the door" — cannot exist any
more. **It had no test pins**; `grep -a` across `packages/` found the string only
at its definition and its one call site.

---

## 3. Where the harness dials, and the one thing added beyond the contract

The contract said `machine: "local"` "continues to work with no base URL". It did
not, at base — see **`docs/verification/door-internal/PARKED.md`** for the
measured evidence. Left alone, mounting an internal door would have turned two
passing live cases from "runs toolless" into "refuses the turn". So the door
target resolves in three steps, all pinned:

1. **Operator-set base wins**, on both legs, always.
2. **A harness that needs no machine** may dial the origin the wire itself was
   reached at. The trust rule is route-binding's own (04 §4): a learned origin
   comes from the Host header, so it is trusted in `NODE_ENV=development` and
   nowhere else. This is what makes zero-config real.
3. **A harness that needs a machine is never handed a learned origin.** A box
   holding a live turn credential must not be pointed at a Host header. With no
   operator base it refuses in the operator's voice — the one deployment gap the
   contract says to keep, unchanged.

And a **local** thinker with no origin at all now **runs** rather than refuses:
nothing was configured wrong, and a subprocess on this machine with no product
actions is the workspace-only assistant that composition has always served.

---

## 4. Line counts — measured, and the lane is net-POSITIVE

The contract predicted "net-negative or ~zero". It is not. Reporting the
measurement, not the prediction.

| production file | before | after | delta |
|---|---|---|---|
| `mcp/src/door.ts` | 1,309 | 1,386 | **+77** |
| `vendo/src/server.ts` | 2,938 | 2,982 | **+44** |
| `core/src/harness.ts` | 157 | 165 | +8 |
| `harnesses/src/claude-code/index.ts` | 487 | 476 | **−11** |
| **total** | **4,891** | **5,009** | **+118** |

Split by kind: **+38 code**, **+77 comment**, +3 blank.

**Why the prediction missed.** "Mostly NOT constructing the outside half" is true
of the *runtime path* and false of the *source*: nothing was removed to get
there, a second entry leg was added beside the first (`#internalOnly`,
`outsideSpacePath`, `locked()`, the constructor guard), plus a second door
composition and a three-way URL rule in the umbrella. The only deletion the
contract named is 12 lines. The honest reading matches door-ctx's: this bought a
**decoupling** — `mcp: true` now means one thing — not fewer lines.

Tests: **+367** (`mcp-door-internal.e2e.test.ts` is 300 new lines, plus +11 in
`claude-code.test.ts` and +68/−12 in the composed live suite).

---

## 5. Proofs

Evidence: `docs/verification/door-internal/`.

| # | proof | status | evidence |
|---|---|---|---|
| 1 | Outside-lockout pin suite, written and run **RED first against a full door** | **PASS** | `lockout-pins-RED-against-full-door.log` (**6 of 9 failing**) → `mcp-door-internal.e2e.test.ts` **13/13** |
| 2 | `mcp: true` byte-identical | **PASS** | outside-agent **7/7** · parity gate **7/7** · turn-credentials **11/11**, all three files **absent from the diff** |
| 3 | Live, on an internal-only composition: box over a real tunnel | **PASS (live)** | `live-internal-door-proof.log` / `.json` — **13/13** |
| 3 | Live, on an internal-only composition: local leg + box driver | **PASS (live)** | `live-composed.log` **5/5** (one re-run, §6) · `live-box.log` **7/7** |
| 4 | Zero-config boot: no warning, working agent | **PASS (live)** | `live-composed.log`, "ZERO CONFIG" |
| 5 | Full gates, twice | **PASS** | §7 |

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

### Red-green verified by weakening the code

- **The door-base trust rule.** Replacing it with an unconditional
  `?? actionsConfig.baseUrl` fails exactly two pins ("a harness that needs a
  MACHINE is NEVER handed a learned origin", "outside development a learned
  origin is not trusted"). Restored → 13/13.
- **`requires.toolDoor`.** Reverting `claudeCode()`'s declaration fails the new
  boot-gate pin (`expected undefined to be true`). Restored → 48/48.

---

## 6. Deviations, and what is not pinned offline

### One live flake, re-run and named

`§1.3 · turn.state is DURABLE` failed once on `expect(second).toContain("5591")`.
The model **did** answer 5591 — the SSE stream carried it as two deltas (`"5"`,
`"591"`), so the raw wire text never contains the literal. A raw-wire assertion
meeting model-side token splitting, not a regression. Re-run scoped: **PASS**
(21.6s). Left as-is: fixing a brittle assertion in someone else's test is its own
change.

### The local-leg no-origin case is proven LIVE, not offline

`claudeCode({ machine: "local" })` cannot be unit-tested: `localMachine()` has no
`openSession` injection point reachable from the `claudeCode()` factory, so a
test would have to run the real Agent SDK. The two `§1.3` live cases ARE the pin
(they compose with no `mcp`, no listener and no base), and a comment in that file
now says so. The BOX half of the same decision is pinned offline in
`claude-code.test.ts`.

### `oauth` became optional on `McpDoorConfig`

Required for an outside-serving door, meaningless for an internal one. The
looser type is closed at construction with a `TypeError` naming the fix, so a
full door cannot silently degrade into an internal one.

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
- `pnpm test --force --concurrency=1` from THIS worktree root, **TWICE**:
  run A **55/55 successful, 0 cached**; run B **55/55 successful, 0 cached**.
  (Tally read, never a piped exit code.)

Per-package on run A: vendo **1903** · core 889 · ui 720 · apps 695 ·
actions 572 · bench 525 · corpus-harness 390 · store 381 · harnesses **246** ·
guard 226 · agent 158 · demo-accounting 152 · genui-bench 122 · telemetry 119 ·
knowledge 114 · demo-bank 102 · mcp **87** · automations 87 · demo-template 82 ·
integration 52 · engine 49 · automations-e2e 36 · redteam 21 · mcp-e2e 19 ·
chat-e2e 13 · video-studio 10 · existing-agents 10 · express-host 6 ·
mastra-agent 5 · vendoai 3. **7,797 passing.**

No load-flakes to classify: run A was clean first time, and both classes the
contract names as not-mine (`harness-system-prompt.test.ts`,
`@vendoai/redteam-e2e`) were green.

Live: **internal-door tunnel proof 13/13** · **composed local 5/5** (after the
one re-run in §6) · **box 7/7** · **mcp-e2e fixture 19/19** (the outside door,
end to end, unchanged).

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
