/**
 * The cc-native PARITY GATE — is the MCP door a drop-in replacement for the
 * in-process tool projection inside a `claudeCode()` turn?
 *
 * The cc-native lane wants to delete the ask/park/queue/cursor bridge and let the
 * box reach the host's tools over native remote MCP
 * (`mcpServers: { vendo: { type: "http", url: <the door>, headers: { Authorization } } }`).
 * That is only allowed if the door produces the SAME accountability as
 * `turn.tools.call()`. So this file runs the same two tool asks — one `read` the
 * `cautious` policy runs, one `write` it parks for a human — through BOTH doors of
 * ONE composed host (one store, one guard, one policy, one registry) and compares:
 *
 *   - the AUDIT ROW: (outcome, decidedBy, presence, venue, subject)
 *   - the APPROVAL BEHAVIOR: does the guard's ask reach the user the same way,
 *     and does a denial behave the same way?
 *
 * It is a MEASUREMENT pinned as a test: the assertions below record the answer we
 * measured, so a future change to either path that closes (or widens) the gap
 * fails here and gets read by a person. Read the recorded verdict in
 * `docs/superpowers/lanes/2026-08-02-cc-native-CLOSE.md`.
 *
 * The composed host and the minimal MCP client live in `mcp-door.test-util.ts`,
 * shared with `mcp-door-outside-agent.e2e.test.ts` so the two files cannot drift
 * into driving different doors.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  MOUNT,
  READ_TOOL,
  SUBJECT,
  WRITE_TOOL,
  bearer,
  composedHost,
  openDoor,
  rowsAddedBy,
  runCleanups,
  runHarnessTurn,
  shapeOf,
  tapWhenItAppears,
  toolRows,
} from "./mcp-door.test-util.js";

afterEach(runCleanups);

// ── the gate ──────────────────────────────────────────────────────────────────

describe("cc-native parity gate — MCP door vs the in-process projection", () => {
  it("a READ the policy runs: the audit rows differ in venue, and the door's row alone is not attributable to the turn", async () => {
    const { vendo, store, observed } = await composedHost(async (call) => {
      await call(READ_TOOL, { query: "balance" });
    });

    const fromTurn = await rowsAddedBy(store, READ_TOOL, async () => {
      await runHarnessTurn(vendo, "thr_read", "look it up");
    });
    expect(observed).toEqual([`${READ_TOOL}:ok`]);
    expect(fromTurn).toHaveLength(1);
    const inProcess = shapeOf(fromTurn[0]);

    const door = await openDoor(vendo, await bearer(vendo));
    const fromDoor = await rowsAddedBy(store, READ_TOOL, async () => {
      const answered = await door.callTool(READ_TOOL, { query: "balance" });
      expect(answered.isError).toBeFalsy();
    });
    expect(fromDoor).toHaveLength(1);
    const throughDoor = shapeOf(fromDoor[0]);

    // THE MEASUREMENT, all five contract-named fields, verbatim. Four of five
    // agree; `venue` does not, and it does not because the door HARDCODES it
    // (`mcpContext`, packages/mcp/src/door.ts) while the in-process projection
    // carries the RUN's own venue. Routing a claudeCode() turn's tools through
    // the door relabels every tool call in every chat turn as MCP traffic — and
    // `venue` is a policy-matchable field (packages/guard/src/policy.ts) and a
    // grant-set predicate (core grant-sets.ts), so this is not cosmetic.
    expect(inProcess).toEqual({
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "chat",
      subject: SUBJECT,
    });
    expect(throughDoor).toEqual({
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
  });

  it("a WRITE the policy parks: the in-process path blocks for the tap and executes; the door refuses and tells the client to go elsewhere", async () => {
    const { vendo, store, observed } = await composedHost(async (call) => {
      await call(WRITE_TOOL, { amount: 1400 });
    });

    // In-process: the card reaches the user mid-turn, the turn WAITS, the tap
    // lands, the call executes. One ask, one human decision, one execution.
    const fromTurn = await rowsAddedBy(store, WRITE_TOOL, async () => {
      const tap = tapWhenItAppears(vendo, WRITE_TOOL, true);
      await runHarnessTurn(vendo, "thr_write", "pay them");
      await tap;
    });
    expect(observed).toEqual([`${WRITE_TOOL}:ok`]);
    const inProcess = shapeOf(fromTurn.at(-1));
    expect(inProcess.outcome).toBe("ok");

    // Through the door: no card on any turn's stream, no wait. The door answers
    // the CALLER with an in-band error naming a queue it cannot reach, and the
    // audit row says `pending-approval` — a different outcome for the same ask.
    const door = await openDoor(vendo, await bearer(vendo));
    const fromDoor = await rowsAddedBy(store, WRITE_TOOL, async () => {
      const answered = await door.callTool(WRITE_TOOL, { amount: 1400 });
      expect(answered.isError).toBe(true);
      expect(answered.text).toContain("needs approval");
    });
    const throughDoor = shapeOf(fromDoor.at(-1));

    // MEASURED DIVERGENCE 2 — approval behavior, on the SAME five fields. Same
    // ask, same guard, same policy: one path is a live approval a human answers
    // inside the turn, the other is a refusal plus a retry instruction. A boxed
    // agent cannot act on "resolve it in the product and retry", and the row it
    // leaves behind is a still-live ask rather than a completed write.
    expect(throughDoor).toEqual({
      outcome: "pending-approval",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
    expect(inProcess.outcome).not.toBe(throughDoor.outcome);
  }, 20_000);

  it("a DENIED write: in-process the model is handed the guard's reason; through the door the reason arrives too, but as the caller's own error", async () => {
    const { vendo, store, observed } = await composedHost(async (call) => {
      await call(WRITE_TOOL, { amount: 9 });
    });

    const tap = tapWhenItAppears(vendo, WRITE_TOOL, false);
    await runHarnessTurn(vendo, "thr_deny", "pay them");
    await tap;
    // The turn saw a plain denial it can narrate — never a throw (contract §1.1).
    expect(observed).toEqual([`${WRITE_TOOL}:denied`]);

    const rows = await toolRows(store, WRITE_TOOL);
    // In-process, a turned-down approval leaves NO executed tool-call row: the
    // call never ran. The door's `pending-approval` row (previous test) records
    // an ask that is still live. Both are honest; they are not the same fact.
    expect(rows.every((row) => row.outcome !== "ok")).toBe(true);
  }, 20_000);

  it("the door cannot be reached with a per-turn token a harness mints — a bearer only exists at the end of an OAuth authorization-code flow", async () => {
    const { vendo } = await composedHost(async () => undefined);

    // The cc-native design's `headers: { Authorization: Bearer <per-turn token> }`
    // has no issuer: the door authenticates ONLY grants minted through its own
    // /register → /authorize → /token flow (10-mcp §3), so a token the harness
    // invents is a 401 and there is no internal mint to call instead.
    const invented = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: "Bearer bxt_a-token-the-harness-minted",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    }));
    expect(invented.status).toBe(401);
  });
});
