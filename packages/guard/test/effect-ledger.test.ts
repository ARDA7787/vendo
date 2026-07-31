import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { FixtureTools, call, context, descriptor, seedGrant } from "./fixtures/tools.js";

/**
 * Build contract §7 — the effect ledger is what makes fail-and-re-run correct.
 *
 * The property under test is deliberately about the SIDE EFFECT, not the answer:
 * a re-run must not call the tool's execute a second time. Asserting only that
 * the outcome matches would pass even if the payment were sent twice, which is
 * the exact bug this table exists to prevent.
 */
const runCtx = (overrides = {}) =>
  context({ trigger: { runId: "run_ledger_1", kind: "schedule" }, ...overrides });

describe("effect ledger (build contract §7)", () => {
  it("does NOT call execute a second time for a repeated mutating call", async () => {
    const store = createMemoryStore();
    const write = descriptor("write");
    await seedGrant(store, { descriptor: write });
    const tools = new FixtureTools();
    const bound = createGuard({ store }).bind(tools);
    const ctx = runCtx();

    const first = await bound.execute(call(write.name, { amount: 100 }), ctx);
    const second = await bound.execute(call(write.name, { amount: 100 }), ctx);

    expect(first.status).toBe("ok");
    // The load-bearing assertion: the effect happened exactly once.
    expect(tools.executions).toHaveLength(1);
    // And the re-run still answers with what actually happened.
    expect(second).toEqual(first);
  });

  it("records the outcome so a re-run answers from the ledger, not from silence", async () => {
    const store = createMemoryStore();
    const write = descriptor("write");
    await seedGrant(store, { descriptor: write });
    const tools = new FixtureTools();
    tools.setOutcome(write.name, { status: "ok", output: { receipt: "rcp_9" } });
    const bound = createGuard({ store }).bind(tools);
    const ctx = runCtx();

    await bound.execute(call(write.name, { amount: 5 }), ctx);
    const replay = await bound.execute(call(write.name, { amount: 5 }), ctx);

    expect(replay).toEqual({ status: "ok", output: { receipt: "rcp_9" } });
    expect(tools.executions).toHaveLength(1);
  });

  it("keys on the exact input: different arguments are a different effect", async () => {
    const store = createMemoryStore();
    const write = descriptor("write");
    await seedGrant(store, { descriptor: write });
    const tools = new FixtureTools();
    const bound = createGuard({ store }).bind(tools);
    const ctx = runCtx();

    await bound.execute(call(write.name, { amount: 100 }), ctx);
    await bound.execute(call(write.name, { amount: 250 }), ctx);

    expect(tools.executions).toHaveLength(2);
  });

  it("keys on the run: the same call in a LATER run executes again", async () => {
    // A ledger that deduplicated across runs would make a daily automation fire
    // exactly once, forever. The key is scoped to the run for that reason.
    const store = createMemoryStore();
    const write = descriptor("write");
    await seedGrant(store, { descriptor: write });
    const tools = new FixtureTools();
    const bound = createGuard({ store }).bind(tools);

    await bound.execute(call(write.name, { amount: 100 }), runCtx());
    await bound.execute(
      call(write.name, { amount: 100 }),
      runCtx({ trigger: { runId: "run_ledger_2", kind: "schedule" } }),
    );

    expect(tools.executions).toHaveLength(2);
  });

  it("never ledgers a CHAT call: the same action asked for twice happens twice", async () => {
    // Regression (found by vendo's compound e2e). A chat session spans many
    // turns, so keying the ledger on sessionId made "pay this invoice" asked
    // twice in one conversation execute once and silently replay the first
    // receipt. There is no "re-run" without a run, so there is nothing to
    // deduplicate: the ledger applies only where ctx.trigger.runId exists.
    const store = createMemoryStore();
    const write = descriptor("write");
    await seedGrant(store, { descriptor: write });
    const tools = new FixtureTools();
    const bound = createGuard({ store }).bind(tools);
    const chat = context({ venue: "chat", presence: "present" });

    await bound.execute(call(write.name, { amount: 100 }, "call_1"), chat);
    await bound.execute(call(write.name, { amount: 100 }, "call_2"), chat);

    expect(tools.executions).toHaveLength(2);
    const ledgered = await store.records("vendo_effects").list({});
    expect(ledgered.records).toHaveLength(0);
  });

  it("never ledgers a read: reads are free to repeat", async () => {
    const store = createMemoryStore();
    const read = descriptor("read");
    const tools = new FixtureTools();
    const bound = createGuard({ store }).bind(tools);
    const ctx = runCtx();

    await bound.execute(call(read.name, { page: 1 }), ctx);
    await bound.execute(call(read.name, { page: 1 }), ctx);

    expect(tools.executions).toHaveLength(2);
    const ledgered = await store.records("vendo_effects").list({});
    expect(ledgered.records).toHaveLength(0);
  });

  it("does not ledger a failure — a failed mutation must be retryable", async () => {
    const store = createMemoryStore();
    const write = descriptor("write");
    await seedGrant(store, { descriptor: write });
    const tools = new FixtureTools();
    tools.setOutcome(write.name, { status: "error", error: { code: "timeout", message: "upstream timed out" } });
    const bound = createGuard({ store }).bind(tools);
    const ctx = runCtx();

    const failed = await bound.execute(call(write.name, { amount: 7 }), ctx);
    expect(failed.status).toBe("error");

    // Now the upstream recovers. The retry MUST reach it.
    tools.setOutcome(write.name, { status: "ok", output: { receipt: "rcp_ok" } });
    const retried = await bound.execute(call(write.name, { amount: 7 }), ctx);

    expect(retried).toEqual({ status: "ok", output: { receipt: "rcp_ok" } });
    expect(tools.executions).toHaveLength(2);
  });
});
