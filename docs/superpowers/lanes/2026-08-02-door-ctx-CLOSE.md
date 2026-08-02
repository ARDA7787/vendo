# Lane CLOSE — the MCP door carries turn context (door-ctx)

**Worktree:** `/Users/yousefh/orca/workspaces/flowlet/door` · branch `rebuild/door-ctx` · base `52eff9d11` (the cc-native head)
**Date:** 2026-08-02 · **Never pushed, no PR, no merge.** Landing is the orchestrator's job, after cc-native lands on `rebuild/cutover`.

---

## 1. The verdict — PARITY. All six divergences closed, gate flipped.

cc-native measured the door and said NOT IDENTICAL, six ways, and kept the
ask/park/answer bridge as a consequence. All six are closed and the gate is
flipped from "documents divergence" to "asserts IDENTICAL":
`packages/vendo/src/mcp-door-parity.e2e.test.ts`, **7/7**.

| # | cc-native measured | now |
|---|---|---|
| 1 | harness-minted bearer → **401**, no issuer exists | a second credential space (10-mcp §3b); the gate's old 401 assertion is now a *works* assertion |
| 2 | `presence` hardcoded `present` — an unattended run **judged attended** | the turn's own; an absent run gets the absent ruling, word for word |
| 3 | `venue` hardcoded `mcp` — a policy-match field and grant-set predicate | the turn's own; a chat turn's call audits `venue: "chat"` |
| 4 | approvals dead-end: in-band "resolve it there, then retry" | the turn's card, the turn's wait, the turn's execute-or-deny |
| 5 | `descriptors()` asked without ctx, so §12 never ran | `turn.tools.list()` (already projected + curated); the OAuth leg passes ctx too |
| 6 | no transcript mirror, no `workspace.commit()` | both, because it *is* `turn.tools.call()` |

**How, in one sentence:** a turn-bearing call is handed straight to
`turn.tools.call()` — the in-process path itself — so the guard decision, the
approval machinery, the audit row, the transcript mirror and the commit are
*inherited*, not reimplemented. Parity is by construction. There is no second
consent system, no second guard, no second audit writer.

**The outside-agent path did not move.** Pinned green against the *unmodified*
door first (`packages/vendo/src/mcp-door-outside-agent.e2e.test.ts`, 7/7, commit
`d195ad576`), still 7/7 after: the verbatim tool listing, the
`ok · rule · present · mcp` read row, the in-band "resolve it there, then retry"
park, the in-band not-found, both 401 shapes, and session-to-grant binding. The
two credential spaces never meet.

---

## 2. The credential, in five plain sentences

1. The host process mints an opaque token for one conversation, and only from
   **inside a live turn** of that conversation — which is what binds it to a
   subject nobody had to name, because the subject is *read off* the turn.
2. The token **states nothing** — no subject, no scope, no venue, no permissions
   — so there is nothing in it to forge; it is a pointer at "the turn currently in
   flight on thread T".
3. Its **authority window is that turn**: between turns it resolves to nothing
   and the call is a 401, because a call with no turn behind it has no
   accountability context to be judged in.
4. It dies on `revoke()` (the machine holding it is being replaced), on an idle
   sweep, and **permanently** if its thread is ever seen carrying a different
   principal.
5. Everything it can reach is what that turn could already reach — `turn.tools`,
   which is the guard-bound registry with the turn's own ctx — so it cannot
   escalate, only *be* the turn.

Registry: `packages/vendo/src/turn-credentials.ts` (the umbrella owns it because
it is the only place holding both ends). Port: `packages/mcp/src/turn-credential.ts`
(layering — `@vendoai/mcp` reaches core only). Publish seam:
`HarnessRuntimeDeps.liveTurn`, called for every turn, retracted in the `finally`.

### The abuse negatives, written and run RED first

`packages/vendo/src/turn-credentials.test.ts` — **11/11**, and the file existed
before the registry did. It refuses: minting outside a turn, another thread's
context (even when that thread is the only one live), any use after the turn
ends, a revoked token mid-turn, an expired one, a malformed one, and a thread
that changed hands. Two were red-green verified by weakening the code:

- Dropping the cross-thread binding → the cross-thread negative fails. ✅
- **The publish-time burn was a real hole the negative found.** It compared
  against the *previously live* turn, which is gone between turns — so a foreign
  turn that came and went with no call arriving left the credential alive, and it
  came back to life on the rightful subject's next turn. Now compared against what
  was *minted*. This is the kind of thing the contract's "two privilege
  escalations were caught pre-merge" warning is about.

`packages/harnesses/src/live-turn.test.ts` (4/4) pins the load-bearing
**identity**: the door is handed the harness's own `turn.tools`, not an
equivalent façade. A fresh façade would pass every behavioural assertion in the
parity gate and silently drop the `commit()`.

---

## 3. What shipped after parity — the flip and the deletion

`claudeCode()` points its session at
`{ type: "http", url: <the host's door>, headers: { Authorization } }` with
`alwaysLoad: true`, and the bridge is gone.

**Deleted:** the in-process MCP server in `claude-turn.ts` (`createSdkMcpServer`,
the JSON-Schema→zod translation, the hook/handler correlation queue that made
exactly-once hold, `GuardedCall`/`GuardedResult`/`ClaudeTurnTool`); the box door's
`callTool`, per-message `asks` map, hand-out-once bookkeeping and
`/session/{id}/answer` route; the `callTool` port in both drivers; and the tool
**fingerprint** that reopened a session whenever the equipped set changed.

**Tool listings are LIVE now.** That last deletion is the one worth naming: an
SDK MCP server's tool set is fixed when the session opens, so a tool `find_tools`
equipped mid-conversation used to cost a session REOPEN. `tools/list` at the door
is answered from `turn.tools.list()` on every ask. cc-native flagged the
snapshot-once limitation as a D2 root cause; it is gone.

**Kept:** the poll loop (it is how text, usage and `wrote` events leave the box,
and MCP changes nothing about that direction of travel), materialization + diff
sync-back, the send-serializing queue, tenant isolation, `machine: "local"`.

---

## 4. Line counts — measured, and the lane is production net-POSITIVE

The contract predicted the deletion "should make this lane strongly
net-negative". It did not. Reporting the measurement, not the prediction.

**The 8 files the contract named** (7 cc-native + `door.ts`): 3,524 → 3,510,
**−14**.

| file | before | after | delta |
|---|---|---|---|
| `apps/src/claude-turn.ts` | 602 | 442 | **−160** |
| `apps/box/turn-routes.mjs` | 410 | 363 | **−47** |
| `claude-code/box.ts` | 346 | 319 | −27 |
| `claude-code/local.ts` | 282 | 273 | −9 |
| `harnesses/materialize.ts` | 234 | 234 | 0 |
| `claude-code/machine.ts` | 100 | 110 | +10 |
| `claude-code/index.ts` | 443 | 487 | +44 |
| `mcp/src/door.ts` | 1,107 | 1,282 | **+175** |

**Every production file this lane touched:** 7,305 → 7,600, **+295**. The rest is
the credential and its wiring: `vendo/turn-credentials.ts` +147,
`mcp/turn-credential.ts` +45, `server.ts` +40, `runtime.ts` +27,
`harness-sandbox.ts` +25, `harness-turn.ts` +15, `state.ts` +7, two index files
+3. Tests: **+744**.

**Why the deletion did not dominate.** The bridge and the projection were ~300
lines. Making the door carry turn context needed a whole new credential space
with its own security properties (a registry, a burn rule, an idle sweep, a
publish/retract seam threaded through four packages) plus a second request leg in
`door.ts` that must never touch the first. The honest reading: this lane bought
**correctness and one less transport**, not fewer lines. Combined with cc-native's
own +318, the `claudeCode()` rewrite is now roughly +600 production lines against
the 3,403 it started from — and the thing that shrank is the number of mechanisms,
not the number of lines.

---

## 5. Proofs

Evidence: `docs/verification/door-ctx/`.

| # | proof | status | evidence |
|---|---|---|---|
| 1 | Parity gate asserts IDENTICAL, 6/6 closed | **PASS** | `mcp-door-parity.e2e.test.ts` 7/7 |
| 2 | Live box: a guarded call travels the door, the card appears, the tap executes, one row + one mirror, commit lands | **PASS (live)** | `live-door-proof.log` / `.json` — **11/11** |
| 3 | Unattended presence through the door | **PASS (live + offline)** | live proof check 5; parity gate §12 + §1.4 cases |
| 4 | Credential abuse negatives; outside client unchanged | **PASS** | `turn-credentials.test.ts` 11/11 (red-first, 2× red-green) · `mcp-door-outside-agent.e2e.test.ts` 7/7 pinned pre-change |
| 5 | box + local live suites | **PASS (live)** | box **7/7** (`live-box.log`) · composed local **4/4** (`live-composed.log`) · local **3/3** (`live-local.log`) |
| 6 | Full gates | **PASS** | §7 |

### Proof 2 in full — the real thing, over a real tunnel

`docs/verification/door-ctx/live-door-proof.mjs` drives a **real e2b box** on the
re-baked template, running a **real Claude Agent SDK session**, reaching a **real
composed host** through a **cloudflared quick tunnel** — a genuine public origin,
because the flip makes the host's door a reachable dependency of a boxed harness
where the inverted bridge needed no inbound path at all. 11/11:

- the read executed host-side, and the audit row said
  `venue: chat · presence: present · outcome: ok · decidedBy: rule` — before this
  lane the identical call would have said `venue: mcp`;
- the model answered with the host's own data (`inv_7781`);
- the transcript mirror carried the call;
- a parked WRITE put a card on the **public approvals queue mid-turn**, the turn
  waited, the tap **executed** it — one `ok` row, `decidedBy: grant`;
- a file the box wrote was readable through the host's workspace door (commit);
- an UNATTENDED turn on the same door: `away`/`automation`, **nothing executed**,
  and the model said *"I'd rather stop than claim something happened that didn't"*;
- a credential outside a turn is **401** at the public door.

### Two bugs the live runs caught that no unit test would have

1. **cloudflared prints its hostname before the edge has it in DNS.** The first
   turn died on `ENOTFOUND`. The proof now polls the real public URL until it
   answers. (The tunnel is also driven from *outside* the script — spawning it
   inline tangled its lifetime with the proof's and never became reachable.)
2. **`server.close()` waits on the SDK's keep-alive MCP socket.** The composed
   live teardown hung past vitest's 30s hook timeout and reported two tests as
   FAILED that had already passed every assertion. `closeAllConnections()` first.
   Worth remembering: a hook timeout is reported identically to a real failure.

### Box template re-baked

`packages/apps/box/**` changed, so: **`VENDO_BOX_TEMPLATE=h5pf20fap7ows6io81kr`**
(was `azldli4bchjbn6gtq3tr`). The box 7/7 live suite above ran on the new one.

---

## 6. Deviations, and one open decision for Yousef

### OPEN DECISION — `claudeCode()` now needs the MCP door open

Its tools travel the door, so a composition with no door (`mcp` unset) gives the
agent its own workspace and **none of the product's actions**. Before this lane
that composition worked fully.

The most reversible default is what shipped: a **loud one-time operator error**
naming the fix (`mcp: true` + `VENDO_BASE_URL`), and the turn continues — the user
is not lied to, because a model with no tool refuses honestly rather than
inventing one. A door that *is* composed but has no reachable URL **refuses the
turn** outright, because that is unambiguously a misconfiguration.

**Recommendation:** make the no-door case a **boot gate** in
`assertHarnessComposable`, so a host learns at startup rather than from a log line
on their first turn. Not done here: it changes `createVendo` composition
semantics, which is a product call, and it would force a door into every existing
`claudeCode()` test. Flagging rather than deciding.

### A box IS now held while a guarded call waits for a human

`APPROVAL_WAIT_MS` (90s) used to elapse inside the *driver*, which armed the idle
timer across it so a wait outliving the idle budget lost the box — and losing it
mid-turn is a case the store survives. The wait now happens inside the door, on
the host, and from the driver it is indistinguishable from a slow tool. So the box
survives the whole window (bounded by `MESSAGE_BUDGET_MS`, 15 min). **Better for
the user** (an approved call resumes on the same live session instead of a fresh
box) and **worse for cost** (a parked write holds a sandbox). Pinned as a test
(`claude-code.test.ts`, "§1.4 · a box IS now held…") so it is not invisible.

### The box gained an outbound credential and needs egress to the host

Before: "a workspace copy, the inference key, and an inbound machine token,
nothing else". Now it also holds a bearer and must resolve the host's origin.
Strictly the **same power** as the bridge it replaces — the bridge could ask the
host to run any tool the turn could run — but it is a real posture change. The
credential rides the `/session/message` payload, never the machine environment, so
an agent dumping its own `env` cannot read it back (proven live: box E7).

### Live tool proofs re-homed, because a door needs a composition

`@vendoai/harnesses` cannot build a composed host (layering), so the two
`machine: "local"` tool proofs moved out of `claude-code.live.test.ts` into
`claude-code-composed.live.test.ts`, which now serves its door on a real
**loopback** listener — the SDK subprocess runs on this machine, so `127.0.0.1` is
a genuine un-mocked origin. Local went 5 → 3 tests and composed 3 → 4; the box's
tool half moved to the tunnel proof. Contract proof 5 asked to "re-run them"; they
could not be re-run unchanged, because the contract itself ordered the deletion of
what they exercised.

### Deleted tests, named

The contract's Delete list says "and their tests". Gone with the machinery:
`jsonSchemaToZodShape` (3), the exactly-once M1 family (4), the native-hook
denial family (4), the in-process projection family (4), the inverted-bridge
family (5), and the tool-listing reopen case. Each was replaced by a test of what
took its place, never simply removed — the door wiring, the box's permission
allow-list, the credential hand-off, and "no tool listing travels any more".

### A denial's shape changed

A guard denial used to come back as the SDK's native `{behavior: "deny"}` (the
co-trained pause-and-explain). It now arrives as the MCP tool's own in-band error
text, because the guard decides at the door and `turn.tools.call()` is atomic —
it cannot be split into a check for the hook and a run for the handler. Live-proven
that the model still narrates and stops: `claude-code-composed.live.test.ts`,
"a guard DENIAL travels the door and is NARRATED, never crashed".

### Not done, deliberately

- **No schema bump.** Nothing new is persisted: the credential lives only in
  process memory, and turn sessions record a non-secret `clientId`
  (`vendo-harness-turn`) in the door's existing in-memory state.
- **No per-turn credential rotation.** The SDK exposes `setMcpServers`, so
  rotating on each turn is available — it buys little (the token has no authority
  outside a turn anyway) and costs an MCP reconnect per message. Named here as the
  lever if it is ever wanted.
- The door's `surfaces.mcp` menu is **not** applied on the turn leg: a chat turn
  is not an MCP surface, and its own curation (loadout, `surfaces.agent`, §12)
  already decided what is callable.

---

## 7. Gates

- `pnpm build` ✅
- `pnpm typecheck` ✅ **43/43**
- `pnpm lint` ✅ **6/6**
- `pnpm test --force --concurrency=1` from THIS worktree root, **TWICE**:
  run A **55/55 successful, 0 cached**; run B **55/55 successful, 0 cached**.
  (Tally read, never a piped exit code.)

Per-package on run A: vendo **1775** · core 884 · ui 683 · apps **633** ·
actions 572 · bench 525 · corpus-harness 390 · store 319 · harnesses **245** ·
guard 206 · agent 158 · demo-accounting 152 · genui-bench 122 · telemetry 119 ·
knowledge 114 · demo-bank 96 · mcp **85** · demo-template 82 · integration 52 ·
engine 49 · automations 47 · video-studio 10 · express-host 6 · mastra-agent 5 ·
ai-sdk-agent 3 · vendoai 3. **7,434 passing.**

Live, after the template re-bake: **live-door-proof 11/11** · **box 7/7** ·
**composed local 4/4** · **local 3/3**.

No load-flakes to classify this round: both full runs were clean on the first
attempt, and `@vendoai-fixtures/integration` (the class the contract names as
not-mine) was green in both.

---

## 8. Unrelated issues noticed, not fixed

- **`pnpm typecheck` does not see test files** (`exclude: ["src/**/*.test.ts"]`).
  This lane's rename of `SessionMessage` left the live suites broken with
  typecheck **43/43 green**; only running the suites found it. Pre-existing and
  already in the agent-memory notes, but it bit again here and is worth a real fix.
- `packages/apps/src/claude-turn.ts` still greps as **binary** (a raw NUL byte) —
  use `grep -a`. Pre-existing.
- `createVendo({ mcp: true })` still warns "zero live host tools" when tools are
  added via `vendo.actions.add()` after construction. Cosmetic, pre-existing, and
  it fires in most of this lane's test output.
- The `model:` deprecation warning fires on every composed test host. Cosmetic.
- **A file that GROWS past `WALK_SKIP_BYTES` (8 MiB) inside the box is deleted
  from the store at turn end.** Flagged by cc-native, still true, still untouched
  — it is real data loss and out of this lane's scope.
