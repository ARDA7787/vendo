# PARKED — door-internal

One item. Not a blocker: a defensible default was taken and the lane completed.
Recorded here with the evidence so the ruling can be revisited cheaply.

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
(`mcp-door-internal.e2e.test.ts` "where an internal door is dialled", and the
two `§1.3` live cases), so a reversal is visible immediately.

**The open question for a human:** is a learned (Host-header-derived) origin
acceptable as a door target for a same-process thinker in development? It is
already accepted for route-binding credential forwarding under exactly the same
rule, which is why it was taken — but it is a security-posture call, not a
factual one.
