---
name: gotcha-mcp-door-not-audit-identical
description: The Vendo MCP door cannot substitute for the in-process tool projection — venue/presence are hardcoded, approvals can't be live, and no bearer can be minted internally
metadata:
  type: project
---

The MCP door (`packages/mcp/src/door.ts`) is NOT a drop-in replacement for
`turn.tools.call()` / the in-process `createSdkMcpServer` projection. Measured
2026-08-02 by an executable gate against one composed host:
`packages/vendo/src/mcp-door-parity.e2e.test.ts` (verdict in
`docs/verification/cc-native/parity-gate.md`).

Six divergences — three measured, three structural:

1. `venue` is hardcoded `"mcp"` in `mcpContext` (~door.ts:1020). The in-process path
   carries the run's venue. `venue` is policy-matchable (`guard/src/policy.ts`) and a
   grant-set predicate, so this changes DECISIONS, not labels.
2. Approvals: the door has no stream for a card, so it returns an in-band
   "resolve it in the product and retry" and leaves `outcome: pending-approval`.
   In-process blocks up to 90s for a real tap and then executes once.
3. No bearer exists to mint. The door only accepts grants from its own
   register → authorize → token PKCE flow and refuses ephemeral principals. A
   harness-invented token is a 401; there is no internal issuing path.
4. `presence` is hardcoded `"present"` with NO parameter to pass — so an unattended
   run would be audited AND judged as attended. Most severe; structural.
5. `descriptors()` is called with no ctx, skipping `projectableForRun` — where THE
   LAW §12 withholds destructive/external tools from an unattended run.
6. No transcript mirror and no `workspace.commit()` per call (the commit is what puts
   the skeleton on screen mid-turn).

**Why:** a lane tried to route `claudeCode()`'s tools through the door to delete the
box's ask/park/queue bridge. The gate said no, so the bridge stayed.

**How to apply:** before ANY proposal to route internal agent tool calls through the
MCP door, re-run that gate. Fixing 1–3 means adding a venue/presence-carrying
internal call path plus a token issuer — new door surface and a new credential flow,
not a config change. Related: [[project-architecture-claims-unimplemented]].
