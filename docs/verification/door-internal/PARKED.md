# PARKED — door-internal

One item. **RESOLVED in fix round 1** — the open question below went to Yousef,
who ruled the learned origin a DEFECT rather than a posture choice. The record
of the original ruling is kept because the measured evidence about the base head
is still the reason the whole three-step rule exists.

---

## P1 · The contract's premise about `machine: "local"` was not true of the base head

**Contract text (HANDOFF §Design 3):**

> KEEP the one real deployment gap exactly as today: sandbox machine with no
> reachable public base URL → the turn refuses in the operator's voice (a box
> cannot dial a door nobody can name). `machine:"local"` loopback continues to
> work with no base URL.

**What was actually true at base `31ddb2afd`.** There is no loopback default
anywhere; the door URL handed to a harness came only from the operator-set base,
and the refusal did not distinguish the two legs.

```
$ git show 31ddb2afd:packages/vendo/src/server.ts | grep -n "MCP_MOUNT, mcpOptions.baseUrl" -B3
2461:        url: (mcpOptions.baseUrl ?? configuredBaseUrl) === undefined
2462:          ? undefined
2463:          : new URL(MCP_MOUNT, mcpOptions.baseUrl ?? configuredBaseUrl).toString(),

$ git show 31ddb2afd:packages/harnesses/src/claude-code/index.ts | sed -n '319,332p'
        if (doorPort.url === undefined) {
          ...
          yield { type: "error", message: "I can't use this product's actions right now." };
          return;
        }
```

So on the base head:

- `mcp: true` + `machine: "local"` + no `VENDO_BASE_URL` → **the turn refuses.**
  Not "continues to work".
- `mcp` unset + `machine: "local"` → no door at all, a loud one-time operator
  error, and a **toolless** turn.

And the composed live suite proves the author knew: every `machine: "local"`
case that needed tools passed an explicit base.

```
$ git show 31ddb2afd:packages/vendo/src/claude-code-composed.live.test.ts | grep -n "mcp: { baseUrl"
143:    mcp: { baseUrl: origin },
214:    mcp: { baseUrl: origin },
```

**Why it mattered.** Left alone, the composition rule would have REGRESSED the
two `§1.3` live cases (which compose with no `mcp`, no listener and no base):
they went from "runs toolless" to "refuses the turn", because an internal door
now exists where none did before.

**The default taken** — the most reversible reading that satisfies both halves
of the clause and the lane's stated GOAL ("works with ZERO extra config"):

1. A harness that needs **no machine** may dial the origin the wire itself was
   reached at, under route-binding's own trust rule (04 §4: learned origins are
   trusted in `NODE_ENV=development` and nowhere else). Zero-config
   `claudeCode({ machine: "local" })` therefore reaches real tools — proven live
   (`live-composed.log`, "ZERO CONFIG").
2. A harness that needs a **machine** is never handed a learned origin, and with
   no operator base it still refuses in the operator's voice — the gap the
   contract says to keep, unchanged.
3. A **local** thinker with no origin at all **runs** rather than refuses. It is
   a workspace-only assistant, which is what that composition has always served.

**What a different ruling would cost.** Reverting (1) is one predicate in
`doorBase()` in `packages/vendo/src/server.ts`; reverting (3) is one predicate
in `packages/harnesses/src/claude-code/index.ts`. Both are pinned
(`mcp-door-internal.e2e.test.ts` "where an internal door is dialled", plus
`claude-code-local.test.ts` for the warn-not-refuse half since round 1), so a
reversal is visible immediately.

**The open question for a human — ANSWERED.** Is a learned
(Host-header-derived) origin acceptable as a door target for a same-process
thinker in development? **No.** The independent checker demonstrated the attack:
one request carrying `Host: attacker.evil` fixed the origin process-wide, and
the harness then sent `Authorization: Bearer vtk_…` and every tool call there —
on `mcp: true` compositions as well as internal-only ones. Yousef ruled it a
defect.

Round 1 closed it with the smallest fix that keeps zero-config dev working: the
tool door keeps its **own** learned origin, **loopback-only** and **fixed by the
first qualifying request**, never route binding's. Step 2 above now reads
"loopback origin" rather than "learned origin"; steps 1 and 3 are unchanged.
Pinned as three attack cases in `mcp-door-internal.e2e.test.ts`.

Route binding's own learned base is still Host-derived and still dev-trusted —
deliberately untouched, and named in the close note's §8, because a poisoned
base there costs a failed fetch rather than a leaked credential.
