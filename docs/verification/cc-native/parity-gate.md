# cc-native parity gate — MCP door vs the in-process tool projection

**Run:** 2026-08-02 · **Verdict: NOT IDENTICAL — tools stay in-process.**

The gate is executable and lives at
`packages/vendo/src/mcp-door-parity.e2e.test.ts`. It drives the same two tool
asks through BOTH doors of ONE composed host (one store, one real guard, one
`cautious` policy, one registry, one subject) and compares the audit row on the
five contract-named fields plus the approval behavior. Raw output:
`parity-gate-output.txt` (4/4 pass).

## What was compared

| | in-process (`turn.tools.call()`) | through the MCP door |
|---|---|---|
| `host_lookup` (read) | `outcome: ok, decidedBy: rule, presence: present, venue: chat, subject: user_parity` | `outcome: ok, decidedBy: rule, presence: present, venue: mcp, subject: user_parity` |
| `host_pay` (write, policy parks) | card reaches the user mid-turn, turn WAITS, tap lands, call executes → `outcome: ok` | in-band error "This action needs approval… resolve it there, then retry" → `outcome: pending-approval` |
| denied write | `{status: "denied"}` the model narrates; no executed row | n/a (never reaches a live decision) |
| harness-minted bearer | n/a | **401** |

## The divergences

**1. `venue` is hardcoded (MEASURED).** `mcpContext` returns
`{ venue: "mcp", presence: "present", … }` (`packages/mcp/src/door.ts:1020`).
The in-process projection carries the RUN's venue (`turn-tools.ts` → `options.ctx`).
Routing a `claudeCode()` turn's tools through the door relabels every tool call
in every chat turn as MCP traffic. `venue` is a policy-match field
(`packages/guard/src/policy.ts:175`) and a grant-set predicate
(`packages/core/src/grant-sets.ts:292`), so this changes decisions, not just labels.

**2. Approval behavior is a different mechanism (MEASURED).** In-process, §1.4 is
a live wait: preview → card on the turn's own stream → `waiter.wait(90s)` → the
approved call executes ONCE inside the turn. The door has no stream to put a card
on: it returns `inBandError("… waiting in <product>'s Vendo approvals queue —
resolve it there, then retry")` (`door.ts:971`) and leaves `pending-approval`.
A boxed agent cannot act on "resolve it in the product and retry", and the row it
leaves is a still-live ask rather than a completed write.

**3. There is no bearer to mint (MEASURED).** The design assumed
`headers: { Authorization: Bearer <per-turn token> }`. The door authenticates ONLY
grants minted through its own `/register` → `/authorize` → `/token` PKCE flow
(10-mcp §3) and refuses ephemeral principals (`door.ts:328`). A token the harness
invents is a 401 and no internal mint exists. Building one means adding an
issuing path to the door — new surface, in a lane whose contract says no new
concepts.

**4. `presence` cannot be expressed (READ FROM CODE — structural).** The door
hardcodes `presence: "present"` and has no input for it at all (`door.ts:1020`).
An unattended `claudeCode()` run (`presence: "away"`) would therefore be audited
AND JUDGED as attended. This is the most severe of the four and it is not a
config gap — there is no parameter to pass.

**5. `descriptors()` is asked without ctx (READ FROM CODE).** `door.ts:450` and
`:493` call `this.#config.tools.descriptors()` with no `ctx`, so the door skips
`projectableForRun` — the place THE LAW (design §12) withholds destructive and
external tools from an unattended run. The in-process `list()` passes `ctx`
precisely so "not projected into an automation run" means not projected
(`turn-tools.ts:184`).

**6. No mirror, no commit (READ FROM CODE).** The in-process path mirrors every
call into the transcript (`MirrorEvent`) and calls `workspace.commit()` after each
one, which is what puts the skeleton on screen mid-turn. The door does neither.
Losing the commit re-opens the 52.8s-silence regression wave 2 caught.

## Consequence taken

Per the contract's own branch: **tools stay in-process** — the
`createSdkMcpServer` projection, unchanged. Everything else in the lane still
shipped (live session, native plugins skills, the short prompt, the `PostToolUse`
hook, and the deletion of the pool / snapshot / token-rotation machinery).

Findings 1–3 are cheap to fix host-side ONLY by adding a presence/venue-carrying
internal call path and a token issuer to the door — i.e. new door surface plus a
new credential flow, which this lane's contract puts out of scope. Findings 4–6
are structural. The orchestrator takes this to Yousef.
