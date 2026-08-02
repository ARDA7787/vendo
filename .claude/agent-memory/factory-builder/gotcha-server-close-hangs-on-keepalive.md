---
name: gotcha-server-close-hangs-on-keepalive
description: A node http server serving vendo.handler for an SDK subprocess hangs in server.close(), and vitest reports the PASSING tests as failed
metadata:
  type: project
---

`server.close()` waits for every keep-alive socket to drain. An Agent SDK
subprocess holding an MCP connection to a loopback door never closes its socket,
so an `afterEach` that awaits `close()` hangs until vitest's **30s hook timeout**
— and vitest then reports the tests as **FAILED even though every assertion
inside them passed**.

**Why:** hook timeouts and assertion failures are reported identically (`FAIL
src/x.test.ts > name`), with the only distinguishing line being
`Error: Hook timed out in 30000ms` further down the output. Measured 2026-08-02
in `claude-code-composed.live.test.ts`: two tests logged the exact successful
tool call and denial narration they were asserting, then reported as failures.

**How to apply:** any test that stands up an `http.createServer` for a
subprocess or a sandbox to call back into must
`server.closeAllConnections()` BEFORE `server.close()`. And when a live test
"fails" with no assertion diff in the output, scroll for `Hook timed out`
before believing the failure is real — see [[gotcha-piped-test-exit-code-lies]]
for the sibling trap where the tally lies the other way.
