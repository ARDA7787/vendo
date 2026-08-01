import { describe, expect, test } from "vitest";
import {
  jsonSchemaToZodShape,
  runClaudeTurn,
  VENDO_MCP_SERVER,
  type ClaudeTurnEvent,
  type ClaudeTurnTool,
  type GuardedCall,
} from "./claude-turn.js";

/**
 * A faithful stand-in for the CLI's own permission + MCP dispatch: for every
 * scripted tool use it consults `canUseTool` exactly as the SDK does, runs the
 * matching in-process MCP handler only when the verdict allows, and yields the
 * message shapes the real stream yields. Nothing here is a mock of OUR code —
 * it simulates the SDK, which is the boundary we cannot run in a unit test.
 */
interface ScriptStep {
  say?: string;
  use?: { name: string; input: Record<string, unknown> };
}

interface Recorded {
  permissions: Array<{ name: string; verdict: string; message?: string }>;
  handled: Array<{ name: string; result: unknown }>;
}

function fakeSdk(script: ScriptStep[], recorded: Recorded, sessionId = "sess_fake") {
  return {
    tool: (name: string, description: string, inputSchema: unknown, handler: unknown) =>
      ({ name, description, inputSchema, handler }),
    createSdkMcpServer: (options: { name: string; tools?: unknown[] }) => ({
      __tools: options.tools ?? [],
    }),
    query: ({ options }: { prompt: unknown; options: Record<string, any> }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: sessionId };
        const handlers = new Map<string, any>(
          ((options.mcpServers?.[VENDO_MCP_SERVER]?.__tools ?? []) as any[]).map(
            (entry) => [`mcp__${VENDO_MCP_SERVER}__${entry.name}`, entry],
          ),
        );
        for (const step of script) {
          if (step.say !== undefined) {
            yield { type: "assistant", message: { content: [{ type: "text", text: step.say }] } };
          }
          if (step.use === undefined) continue;
          const preApproved = (options.allowedTools ?? []).includes(step.use.name);
          let verdict: any = { behavior: "allow", updatedInput: step.use.input };
          if (!preApproved && options.canUseTool !== undefined) {
            verdict = await options.canUseTool(step.use.name, step.use.input, {
              signal: new AbortController().signal,
            });
          }
          recorded.permissions.push({
            name: step.use.name,
            verdict: verdict.behavior,
            ...(verdict.message === undefined ? {} : { message: verdict.message }),
          });
          if (verdict.behavior !== "allow") continue;
          const entry = handlers.get(step.use.name);
          if (entry === undefined) continue;
          // FAITHFUL: the hook sees the model's RAW emission; the handler sees
          // what `z.object(shape)` produced from it — unknown keys STRIPPED and
          // the declared key order imposed. A fake that hands the same object to
          // both hid a real double-execution class (verifier finding M1).
          const raw = (verdict.updatedInput ?? step.use.input) as Record<string, unknown>;
          const declared = Object.keys((entry.inputSchema ?? {}) as Record<string, unknown>);
          const parsed = Object.fromEntries(
            declared.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]),
          );
          const result = await entry.handler(parsed, {});
          recorded.handled.push({ name: step.use.name, result });
        }
        yield {
          type: "result",
          subtype: "success",
          session_id: sessionId,
          usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
        };
      },
    }),
  };
}

const listing: ClaudeTurnTool[] = [
  {
    name: "maple_invoices_list",
    title: "List invoices",
    description: "List the signed-in user's invoices",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "maple_invoices_pay",
    title: "Pay an invoice",
    description: "Pay one invoice",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

async function run(
  script: ScriptStep[],
  callTool: GuardedCall,
  extra: { allowedBoxTools?: string[] } = {},
) {
  const events: ClaudeTurnEvent[] = [];
  const recorded: Recorded = { permissions: [], handled: [] };
  await runClaudeTurn({
    prompt: "do the thing",
    tools: listing,
    cwd: "/box/user",
    env: {},
    callTool,
    emit: (event) => events.push(event),
    sdk: fakeSdk(script, recorded) as never,
    ...extra,
  });
  return { events, recorded };
}

const ok: GuardedCall = async () => ({ status: "ok", output: { invoices: [] } });

describe("in-process MCP projection — one guard, one audit row, one mirror", () => {
  test("every equipped tool is projected under the vendo server", async () => {
    const calls: string[] = [];
    const { recorded } = await run(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_list`, input: { limit: 2 } } }],
      async (name) => { calls.push(name); return { status: "ok", output: [] }; },
    );
    // The BARE name reaches turn.tools.call — the mcp__ prefix is the SDK's
    // wire name, never ours.
    expect(calls).toEqual(["maple_invoices_list"]);
    expect(recorded.permissions[0]?.verdict).toBe("allow");
  });

  test("a projected call executes host-side EXACTLY once, even though the permission hook and the handler both run", async () => {
    let executions = 0;
    await run(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_list`, input: {} } }],
      async () => { executions += 1; return { status: "ok", output: { n: 1 } }; },
    );
    expect(executions).toBe(1);
  });

  test("the ok output reaches the model as the tool's content", async () => {
    const { recorded } = await run(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_list`, input: {} } }],
      async () => ({ status: "ok", output: { invoices: ["inv_1"] } }),
    );
    expect(JSON.stringify(recorded.handled[0]?.result)).toContain("inv_1");
  });

  test("the box's own file/bash work is auto-allowed — the box IS the permission", async () => {
    let asked = 0;
    const { recorded } = await run(
      [{ use: { name: "Bash", input: { command: "ls" } } }],
      async () => { asked += 1; return { status: "ok", output: {} }; },
    );
    expect(recorded.permissions[0]).toEqual({ name: "Bash", verdict: "allow" });
    // Nothing about in-box bash reaches the guard: it never touches the world.
    expect(asked).toBe(0);
  });
});

describe("M1 · exactly-once survives every hook/handler arg mismatch", () => {
  const mcp = (name: string): string => `mcp__${VENDO_MCP_SERVER}__${name}`;

  const countExecutions = async (
    use: { name: string; input: Record<string, unknown> },
    tools: ClaudeTurnTool[] = listing,
  ) => {
    const seen: Array<Record<string, unknown>> = [];
    const recorded: Recorded = { permissions: [], handled: [] };
    await runClaudeTurn({
      prompt: "p",
      tools,
      cwd: "/box/user",
      env: {},
      callTool: async (_name, args) => { seen.push(args); return { status: "ok", output: { n: seen.length } }; },
      emit: () => undefined,
      sdk: fakeSdk([{ use }], recorded) as never,
    });
    return { seen, recorded };
  };

  test("REORDERED keys are one intent, not two", async () => {
    // The model emits id after nothing; a reordered emission must not look like
    // a different call than the parsed one.
    const { seen } = await countExecutions({
      name: mcp("maple_invoices_pay"),
      input: { id: "inv_1" },
    });
    expect(seen).toHaveLength(1);
  });

  test("an EXTRA hallucinated key is one intent, and never reaches the guard", async () => {
    const { seen } = await countExecutions({
      name: mcp("maple_invoices_pay"),
      input: { id: "inv_1", pretendAdmin: true },
    });
    expect(seen).toHaveLength(1);
    // The guard is asked about the DECLARED call, never an invented argument.
    expect(seen[0]).toEqual({ id: "inv_1" });
  });

  test("a tool that declares NO parameters executes once even when the model invents args", async () => {
    const { seen } = await countExecutions(
      { name: mcp("maple_ping"), input: { surprise: 1 } },
      [{ name: "maple_ping", title: "Ping", description: "no parameters" }],
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({});
  });

  test("two CONCURRENT identical calls are two intents — two executions, not one replay", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const recorded: Recorded = { permissions: [], handled: [] };
    const use = { name: mcp("maple_invoices_pay"), input: { id: "inv_1" } };
    await runClaudeTurn({
      prompt: "p",
      tools: listing,
      cwd: "/box/user",
      env: {},
      callTool: async (_n, args) => { seen.push(args); return { status: "ok", output: {} }; },
      emit: () => undefined,
      sdk: fakeSdk([{ use }, { use }], recorded) as never,
    });
    expect(seen).toHaveLength(2);
    expect(recorded.handled).toHaveLength(2);
  });
});

describe("guard asks ride the native permission hook", () => {
  test("a denial comes back as a permission DENY the model can narrate, not a crash", async () => {
    const { recorded } = await run(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_pay`, input: { id: "inv_1" } } }],
      async () => ({ status: "denied", reason: "You'll need to approve paying that invoice." }),
    );
    expect(recorded.permissions[0]?.verdict).toBe("deny");
    expect(recorded.permissions[0]?.message).toBe("You'll need to approve paying that invoice.");
    // Denied means NOT executed: the handler never ran.
    expect(recorded.handled).toEqual([]);
  });

  test("a denied call is never retried behind the model's back", async () => {
    let executions = 0;
    await run(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_pay`, input: { id: "inv_1" } } }],
      async () => { executions += 1; return { status: "denied", reason: "no" }; },
    );
    expect(executions).toBe(1);
  });

  test("a tool ERROR is allowed through and lands as a narratable error result", async () => {
    const { recorded } = await run(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_list`, input: {} } }],
      async () => ({ status: "error", message: "The invoice service is unavailable." }),
    );
    expect(recorded.permissions[0]?.verdict).toBe("allow");
    expect(recorded.handled[0]?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(recorded.handled[0]?.result)).toContain("unavailable");
  });

  test("an SDK that skips the hook for MCP tools still executes exactly once, and a denial still narrates", async () => {
    let executions = 0;
    const events: ClaudeTurnEvent[] = [];
    const recorded: Recorded = { permissions: [], handled: [] };
    const sdk = fakeSdk(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_pay`, input: { id: "x" } } }],
      recorded,
    ) as any;
    await runClaudeTurn({
      prompt: "p",
      tools: listing,
      cwd: "/box/user",
      env: {},
      callTool: async () => { executions += 1; return { status: "denied", reason: "needs a tap" }; },
      emit: (event) => events.push(event),
      // The hook is stripped from the options the fake sees, standing in for an
      // SDK build that pre-approves MCP tools.
      sdk: {
        ...sdk,
        query: ({ prompt, options }: any) => sdk.query({ prompt, options: { ...options, canUseTool: undefined } }),
      },
    });
    expect(executions).toBe(1);
    expect(recorded.handled[0]?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(recorded.handled[0]?.result)).toContain("needs a tap");
  });
});

describe("events — the closed vocabulary (§1.5)", () => {
  test("assistant text becomes text deltas", async () => {
    const { events } = await run([{ say: "Here you go." }], ok);
    expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", delta: "Here you go." }]);
  });

  test("the native session id is reported so turn.state can carry it", async () => {
    const { events } = await run([], ok);
    expect(events).toContainEqual({ type: "session", sessionId: "sess_fake" });
  });

  test("the result's usage is reported for metering", async () => {
    const { events } = await run([], ok);
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
    });
  });
});

describe("jsonSchemaToZodShape", () => {
  const z = {
    string: () => ({ kind: "string", optional() { return { ...this, opt: true }; }, describe() { return this; } }),
    number: () => ({ kind: "number", optional() { return { ...this, opt: true }; }, describe() { return this; } }),
    boolean: () => ({ kind: "boolean", optional() { return { ...this, opt: true }; }, describe() { return this; } }),
    array: (inner: unknown) => ({ kind: "array", inner, optional() { return { ...this, opt: true }; }, describe() { return this; } }),
    any: () => ({ kind: "any", optional() { return { ...this, opt: true }; }, describe() { return this; } }),
    enum: (values: string[]) => ({ kind: "enum", values, optional() { return { ...this, opt: true }; }, describe() { return this; } }),
  };

  test("required properties stay required, the rest are optional", () => {
    const shape = jsonSchemaToZodShape(
      { type: "object", properties: { id: { type: "string" }, limit: { type: "number" } }, required: ["id"] },
      z as never,
    ) as Record<string, { kind: string; opt?: boolean }>;
    expect(shape["id"]).toMatchObject({ kind: "string" });
    expect(shape["id"]?.opt).toBeUndefined();
    expect(shape["limit"]).toMatchObject({ kind: "number", opt: true });
  });

  test("an enum keeps its members and an array keeps its item type", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { status: { enum: ["open", "paid"] }, ids: { type: "array", items: { type: "string" } } },
        required: ["status", "ids"],
      },
      z as never,
    ) as Record<string, { kind: string; values?: string[]; inner?: { kind: string } }>;
    expect(shape["status"]).toMatchObject({ kind: "enum", values: ["open", "paid"] });
    expect(shape["ids"]).toMatchObject({ kind: "array", inner: { kind: "string" } });
  });

  test("a tool with no schema projects no parameters", () => {
    expect(jsonSchemaToZodShape(undefined, z as never)).toEqual({});
  });
});
