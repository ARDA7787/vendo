/**
 * `machine: "local"` holds ONE session per thread — and must re-point it at each
 * new turn's sinks.
 *
 * The bug this file exists for, measured live 2026-08-02: the session is opened
 * on the FIRST message and reused after, so it captured that first turn's `emit`
 * and `callTool` closures. Turn 2's text was then delivered to turn 1's event
 * queue, which nobody was draining any more, and the user's second message came
 * back completely EMPTY. The box path never had this bug because its `emit`
 * routes through whichever message is in flight; local mode has to do the same.
 */
import { describe, expect, test } from "vitest";
import { localMachine, disposeLocalSessions } from "./local.js";
import type { ClaudeTurnEvent } from "@vendoai/apps/claude-turn";

/** A session double that captures the sinks it was OPENED with, and replays each
 *  `send()` through them — exactly what the real SDK session does. */
function sessionDouble() {
  const opens: Array<Record<string, unknown>> = [];
  const factory = (input: Record<string, unknown>) => {
    opens.push(input);
    return {
      async send(prompt: string) {
        (input["emit"] as (event: ClaudeTurnEvent) => void)({ type: "text", delta: `re: ${prompt}` });
        await (input["callTool"] as (name: string, args: unknown) => Promise<unknown>)("host_ping", {});
      },
      async interrupt() { /* nothing to stop in a double */ },
      async end() { /* nothing to close */ },
    };
  };
  return { factory, opens };
}

describe("machine: \"local\" — one session, many turns", () => {
  test("turn 2's text reaches TURN 2's emit, not the closure the session was opened with", async () => {
    const double = sessionDouble();
    const threadId = `thr_local_${Math.random().toString(36).slice(2)}`;

    const firstEvents: ClaudeTurnEvent[] = [];
    const first = await localMachine({ threadId, env: {}, openSession: double.factory as never });
    await first.send({
      prompt: "one",
      tools: [],
      callTool: async () => ({ status: "ok", output: {} }),
      emit: (event) => firstEvents.push(event),
    });
    await first.release();

    const secondEvents: ClaudeTurnEvent[] = [];
    const secondCalls: string[] = [];
    const second = await localMachine({ threadId, env: {}, openSession: double.factory as never });
    // The session is reused — that is the point of the lane.
    expect(second.carriesSession).toBe(true);
    await second.send({
      prompt: "two",
      tools: [],
      callTool: async (name) => { secondCalls.push(name); return { status: "ok", output: {} }; },
      emit: (event) => secondEvents.push(event),
    });

    expect(double.opens).toHaveLength(1);
    // THE BUG: these two went to `firstEvents` instead.
    expect(secondEvents).toEqual([{ type: "text", delta: "re: two" }]);
    expect(firstEvents).toEqual([{ type: "text", delta: "re: one" }]);
    // And the guarded call has to reach THIS turn's guard, or turn 2's tool calls
    // would be audited against turn 1's context.
    expect(secondCalls).toEqual(["host_ping"]);

    await disposeLocalSessions();
  });
});
