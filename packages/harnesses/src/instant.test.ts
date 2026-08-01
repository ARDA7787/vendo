/**
 * `instant()` — the specialist. Every test here drives it through the REAL
 * harness runtime, because the failure mode this wave keeps producing is correct
 * code with no caller: a unit test of the router would not tell you a turn ever
 * reaches it.
 */
import {
  VENDO_APPS_CREATE_TOOL,
  type ThreadId,
  type ToolDescriptor,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { instant } from "./instant.js";
import { createHarnessRuntime } from "./runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  toolCallTurn,
  textTurn,
  userMessage,
  type TestTool,
} from "./test-doubles.test-util.js";
import type { LanguageModel, UIMessage } from "ai";

const THREAD = "thr_instant" as ThreadId;

const appsTool = (name: string): ToolDescriptor => ({
  ...readTool(name, "read"),
  name,
  title: name === VENDO_APPS_CREATE_TOOL ? "Build an app" : "Change an app",
});

/** The apps pack's two hot tools, plus whatever else a case wants equipped. */
function appsRegistry(guard: ReturnType<typeof testGuard>, extra: Record<string, TestTool> = {}) {
  return boundRegistry(
    {
      [VENDO_APPS_CREATE_TOOL]: {
        descriptor: appsTool(VENDO_APPS_CREATE_TOOL),
        execute: () => ({ kind: "tree", appId: "app_7", payload: { root: "r", nodes: [] } }),
      },
      vendo_apps_edit: {
        descriptor: appsTool("vendo_apps_edit"),
        execute: () => ({ app: { id: "app_7" } }),
      },
      ...extra,
    },
    guard,
  );
}

interface RunOptions {
  registry: ReturnType<typeof boundRegistry>;
  guard: ReturnType<typeof testGuard>;
  model: LanguageModel;
  messages?: UIMessage[];
  /** Already-persisted history. Server-authored messages can only arrive this
   *  way — `validateUpsert` refuses a client that posts an assistant turn. */
  seed?: UIMessage[];
}

async function runInstant(options: RunOptions) {
  const transcript = testTranscript();
  for (const [seq, message] of (options.seed ?? []).entries()) {
    await transcript.upsert({ kind: "user", subject: "u1" }, THREAD, message, seq);
  }
  const runtime = createHarnessRuntime({
    tools: options.registry,
    guard: options.guard,
    skills: testSkills(),
    transcript,
  });
  const parts = await readSse(
    await runtime.run({
      harness: instant(),
      threadId: THREAD,
      messages: options.messages ?? [userMessage("m1", "go")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: seats(options.model),
      interactive: true,
      system: "You serve Maple, a bank.",
    }),
  );
  return { parts, transcript };
}

/** Everything the assistant said this turn, joined. */
const saidBy = (parts: Array<Record<string, unknown>>): string =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => String(part.delta))
    .join("");

const toolInputs = (parts: Array<Record<string, unknown>>): Array<{ name: string; input: unknown }> =>
  parts
    .filter((part) => part.type === "tool-input-available")
    .map((part) => ({ name: String(part.toolName), input: part.input }));

describe("instant() — an app ask goes STRAIGHT to the apps tool", () => {
  it("routes a create with ONE model call and no resident loop", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "create", prompt: "a spending dashboard for this month" }),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "build me a spending dashboard")],
    });

    // The whole point of the specialist: one routing call, then the pipeline.
    // A resident that had to "decide to use a tool" would cost a second one.
    expect(model.calls).toBe(1);
    expect(registry.invocations[VENDO_APPS_CREATE_TOOL]).toBe(1);
    expect(toolInputs(parts)).toEqual([
      { name: VENDO_APPS_CREATE_TOOL, input: { prompt: "a spending dashboard for this month" } },
    ]);
    // The view is already on the user's screen; the assistant says one short
    // true thing rather than narrating.
    expect(saidBy(parts).length).toBeGreaterThan(0);
  });

  it("edits the app the thread is already about, without being told its id", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "edit", appId: "app_7", instruction: "make the chart a bar chart" }),
    ]);
    // The mirrored result of an earlier create — how a thread carries its app id.
    const seed: UIMessage[] = [
      userMessage("m1", "build me a dashboard"),
      {
        id: "m2",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: VENDO_APPS_CREATE_TOOL,
          toolCallId: "call_1",
          state: "output-available",
          input: { prompt: "a dashboard" },
          output: { kind: "tree", appId: "app_7" },
        }],
      } as unknown as UIMessage,
    ];

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      seed,
      messages: [...seed, userMessage("m3", "make the chart a bar chart")],
    });

    expect(registry.invocations["vendo_apps_edit"]).toBe(1);
    expect(toolInputs(parts)).toEqual([
      { name: "vendo_apps_edit", input: { appId: "app_7", instruction: "make the chart a bar chart" } },
    ]);
  });

  it("never routes to an apps tool the deployment did not equip", async () => {
    const guard = testGuard();
    // No apps pack: only a host tool.
    const registry = boundRegistry(
      { maple_balance: { descriptor: readTool("maple_balance"), execute: () => ({ balance: 12 }) } },
      guard,
    );
    const model = scriptedModel([
      // Router says "create" anyway — a model can always answer outside the world.
      toolCallTurn("route", { do: "create", prompt: "a dashboard" }),
      textTurn("I can tell you your balance instead."),
    ]);

    const { parts } = await runInstant({ registry, guard, model, messages: [userMessage("m1", "dashboard")] });

    expect(toolInputs(parts).map((call) => call.name)).not.toContain(VENDO_APPS_CREATE_TOOL);
    expect(saidBy(parts)).toContain("balance");
  });
});

describe("instant() — non-app asks still act, through the same guard door", () => {
  it("runs a host tool and reports back, capped so it is never a loop", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard, {
      maple_pay: { descriptor: readTool("maple_pay", "destructive"), execute: () => ({ paid: true }) },
    });
    const model = scriptedModel([
      toolCallTurn("route", { do: "act" }),
      toolCallTurn("maple_pay", { amount: 20 }),
      textTurn("Sent $20."),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "pay Ada $20")],
    });

    expect(registry.invocations["maple_pay"]).toBe(1);
    expect(saidBy(parts)).toContain("Sent $20.");
    // Router + act + report. A third acting step would be a thinking loop, and
    // instant() is the harness that does not have one.
    expect(model.calls).toBe(3);
  });

  it("leaves an audit row with the SAME shape vendo()'s guarded call leaves (E7)", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard, {
      maple_pay: { descriptor: readTool("maple_pay", "destructive"), execute: () => ({ paid: true }) },
    });
    const model = scriptedModel([
      toolCallTurn("route", { do: "act" }),
      toolCallTurn("maple_pay", { amount: 20 }),
      textTurn("Sent $20."),
    ]);

    await runInstant({ registry, guard, model, messages: [userMessage("m1", "pay Ada $20")] });

    const call = guard.events.find((event) => event.kind === "tool-call");
    expect(call).toMatchObject({
      kind: "tool-call",
      tool: "maple_pay",
      outcome: "ok",
      principal: { kind: "user", subject: "u1" },
      venue: "chat",
      presence: "present",
    });
    // And the turn's own row names the harness that ran, so metering can tell
    // instant() spend from vendo() spend.
    const run = guard.events.find((event) => event.kind === "run");
    expect(run?.detail).toMatchObject({ harness: "instant" });
  });
});

describe("instant() — the honest refusal", () => {
  it("says why in the consumer's voice and calls nothing", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", {
        do: "cannot",
        reasons: ["Maple can't move money to an account outside your own."],
      }),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "wire $5k to my cousin")],
    });

    expect(toolInputs(parts)).toEqual([]);
    expect(saidBy(parts)).toContain("Maple can't move money to an account outside your own.");
    // No internals, no apology-with-a-stack-trace.
    expect(saidBy(parts)).not.toContain("route");
  });
});

describe("instant() — the cheap exits", () => {
  it("spends nothing when the caller already hung up", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([]);
    const controller = new AbortController();
    controller.abort();

    const runtime = createHarnessRuntime({
      tools: registry,
      guard,
      skills: testSkills(),
      transcript: testTranscript(),
    });
    await readSse(
      await runtime.run({
        harness: instant(),
        threadId: THREAD,
        messages: [userMessage("m1", "build me a dashboard")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: seats(model),
        interactive: true,
        signal: controller.signal,
      }),
    );

    expect(model.calls).toBe(0);
  });

  it("reports a refused apps call as a refusal, not as a crash", async () => {
    const guard = testGuard({ [VENDO_APPS_CREATE_TOOL]: "block" });
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "create", prompt: "a dashboard" }),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "build me a dashboard")],
    });

    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(saidBy(parts).length).toBeGreaterThan(0);
  });
});
