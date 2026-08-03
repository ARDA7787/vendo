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

~~Route binding's own learned base is still Host-derived and still dev-trusted —
deliberately untouched, because a poisoned base there costs a failed fetch
rather than a leaked credential.~~ **RETRACTED in round 2 — that was false.** It
was leaking the caller's real `cookie` and `authorization` to the spoofed
origin. Fenced with the same `isLoopbackOrigin` predicate; see close note §9.

---

## P2 · An arbitrary PORT on loopback is accepted (residual in the fence)

**Found by the independent checker**, in the fence built in round 1 and extended
to route binding in round 2.

`isLoopbackOrigin` accepts any port on `localhost` / `127.0.0.1` / `::1`. So on a
developer's machine, in `NODE_ENV=development`, with no `VENDO_BASE_URL`, a local
process that can (a) listen on some port and (b) win the FIRST qualifying wire
request can become the learned origin — capturing the turn credential (tool
door) or the caller's forwarded credentials (route binding).

**Scope: same-machine, development-only, and it must win a race against the
host's own first request.** An attacker already running arbitrary local code on
a developer's laptop has cheaper paths to the same secrets (read the process
env, read `~/.claude`, attach a debugger).

**Not fixed, deliberately.** Every cheap fence I could see breaks the thing the
loopback rule exists for:

- pinning the port would need the host to tell us its port, which is exactly the
  configuration zero-config removes;
- comparing against the listening socket is not reachable from a fetch-style
  `handler(request)` with no server object;
- requiring `VENDO_BASE_URL` in development is the status quo ante — it deletes
  zero-config rather than securing it.

The honest framing: loopback-only turns a **remote** attack (any client sending a
Host header) into a **local** one (code already on the machine). That is the
whole of what it buys, and it is worth having.

Revisit if a cheap port fence appears, or if the checker's threat model puts
hostile local processes in scope for dev machines.

## P3 · An UNTRUSTED learned base still RESOLVES route bindings

Round 2 fenced the **trust** flag, not the learner. A spoofed Host learned first
still becomes `actionsConfig.baseUrl`, so route-binding calls resolve against it
— they just carry no `cookie` and no `authorization`, and the withholding is
audited as `untrusted-host-origin`.

**Deliberate, and pre-existing.** This is already how production behaves for any
deployment without `VENDO_BASE_URL`: the learned base resolves, untrusted.
Fencing resolution too would break zero-config same-origin routing for every
such deployment, which is a far larger blast radius than the credential fix
needed — and the credential leak was the measured harm.

Residual harm: tool ARGUMENTS (not the caller's identity) can reach a
spoofed origin in that window. Worth a separate look with its own scope; not
something to bundle into a security fix under review.
