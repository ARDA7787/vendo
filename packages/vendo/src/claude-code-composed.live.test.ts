/**
 * `claudeCode()` through the REAL composition — wave 2 lane E's acceptance half
 * that a unit test cannot reach.
 *
 * `harness-wire.test.ts` proves the composed path with SCRIPTED harnesses on
 * purpose (a model would make it measure a provider). This file is the opposite
 * trade, and it is gated on `ANTHROPIC_API_KEY` so CI never pays it: one real
 * `claudeCode()` turn through `createVendo` → `vendo.handler` → the store, so
 * three things stop being inference and become facts:
 *
 *   - the composed slot actually drives the Agent SDK (E1);
 *   - `audit ⊇ transcript` holds on a claudeCode run (E7 — `audit-superset.e2e.test.ts`
 *     is the bar, and a guarded call made from inside a box has to clear it);
 *   - `turn.state` is DURABLE across turns through the store, not a process-lifetime
 *     map, and a HARNESS SWAP mid-conversation continues the thread from our
 *     transcript rather than restarting it (§1.3).
 *
 * `machine: "local"` because the box leg is proven separately
 * (`packages/harnesses/src/claude-code/claude-code-box.live.test.ts`) and adds a
 * provider account to a test whose subject is composition.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { claudeCode } from "@vendoai/harnesses/claude-code";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const live = process.env["ANTHROPIC_API_KEY"] === undefined ? describe.skip : describe;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

const principal: Principal = { kind: "user", subject: "user_claude_composed" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-cc-composed-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const post = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function hostTools(): { tools: ToolRegistry; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const descriptor: ToolDescriptor = {
    name: "maple_invoices_list",
    title: "List invoices",
    description: "List the signed-in customer's invoices",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  };
  return {
    calls,
    tools: {
      async descriptors() { return [descriptor]; },
      async execute(call) {
        calls.push((call.args ?? {}) as Record<string, unknown>);
        return { status: "ok", output: { invoices: [{ id: "inv_1" }, { id: "inv_2" }] } };
      },
    },
  };
}

async function compose(overrides: Record<string, unknown> = {}): Promise<{
  vendo: Vendo;
  store: VendoStore;
  host: ReturnType<typeof hostTools>;
}> {
  const store = await tempStore();
  const host = hostTools();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(host.tools);
  return { vendo, store, host };
}

const auditRows = async (store: VendoStore): Promise<Array<Record<string, unknown>>> => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: principal.subject } });
  return records.map((record) => record.data as Record<string, unknown>);
};

live("claudeCode() through createVendo", () => {
  it("E1/E7 · serves a real turn, runs a guarded call, and keeps audit ⊇ transcript", async () => {
    const { vendo, store, host } = await compose({
      harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 10 }),
    });

    const turn = await vendo.handler(post("/threads", {
      threadId: "thr_cc",
      message: userMessage("m1", "How many invoices are open? Just tell me the number."),
    }));
    expect(turn.status).toBe(200);
    const wire = await turn.text();
    console.log("[composed turn]", JSON.stringify({ wire: wire.slice(0, 1200), calls: host.calls }));

    // The composed slot drove the real SDK, and the guarded call executed on OUR
    // side — the box (here, the local machine) never touches the world.
    expect(host.calls).toHaveLength(1);

    const fetched = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_cc"));
    const thread = await fetched.json() as { messages: Array<{ role: string; parts: Array<{ type: string }> }> };
    expect(thread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    // E7's bar: every guarded call that reached the TRANSCRIPT has an audit row,
    // and the audit plane additionally carries what the transcript never does.
    const rows = await auditRows(store);
    const toolRows = rows.filter((row) => row["kind"] === "tool-call");
    const transcriptToolParts = thread.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "dynamic-tool" || part.type.startsWith("tool-"));
    console.log("[composed audit]", JSON.stringify({
      kinds: rows.map((row) => row["kind"]),
      toolRows: toolRows.length,
      transcriptToolParts: transcriptToolParts.length,
    }));
    expect(toolRows.length).toBeGreaterThanOrEqual(transcriptToolParts.length);
    expect(transcriptToolParts.length).toBeGreaterThan(0);
    // Metering rides the audit plane ONLY, so billing never reads the story layer.
    const runRow = rows.find((row) => row["kind"] === "run");
    expect((runRow?.["detail"] as { usage?: unknown } | undefined)?.usage).toBeDefined();
    expect(JSON.stringify(thread.messages)).not.toContain("inputTokens");
  }, 420_000);

  it("§1.3 · turn.state is DURABLE: a second composition on the same store resumes the session", async () => {
    const store = await tempStore();
    const runTurn = async (id: string, text: string): Promise<string> => {
      // A FRESH createVendo each turn — the process-lifetime map this replaced
      // would hand turn 2 a blank slate and pay a re-seed every single time.
      const host = hostTools();
      const vendo = createVendo({
        model: {} as LanguageModel,
        principal: async () => principal,
        store,
        harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 6 }),
      } as Parameters<typeof createVendo>[0]);
      vendo.actions.add(host.tools);
      const response = await vendo.handler(post("/threads", {
        threadId: "thr_durable",
        message: userMessage(id, text),
      }));
      return await response.text();
    };

    await runTurn("m1", "Remember the number 5591. Just say ok.");
    const stored = await store.records("vendo_state").list({});
    console.log("[composed state]", JSON.stringify(stored.records.map((record) => record.id)));
    // No new table: the state rides vendo_state under a namespaced app id.
    expect(stored.records.some((record) => String(record.id).includes("harness_state:thr_durable"))).toBe(true);

    const second = await runTurn("m2", "What number did I ask you to remember? Reply with digits only.");
    console.log("[composed resume]", JSON.stringify({ tail: second.slice(-600) }));
    expect(second).toContain("5591");
  }, 600_000);

  it("§1.3 · a mid-conversation SWAP continues the thread from our transcript", async () => {
    const store = await tempStore();
    const host = hostTools();
    // Turn 1 answered by a DIFFERENT thinker, which is what makes turn 2 a swap:
    // the state slot belongs to another harness, so §1.3 clears it and the
    // re-seed has to come from the transcript we own.
    const other = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: defineHarness({
        name: "scripted",
        async *run() {
          yield { type: "text", delta: "Your favourite colour is teal. Noted." };
        },
      }) as never,
    } as Parameters<typeof createVendo>[0]);
    other.actions.add(host.tools);
    await other.handler(post("/threads", {
      threadId: "thr_swap",
      message: userMessage("m1", "My favourite colour is teal. Remember it."),
    }));

    const swapped = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 6 }),
    } as Parameters<typeof createVendo>[0]);
    swapped.actions.add(hostTools().tools);
    const response = await swapped.handler(post("/threads", {
      threadId: "thr_swap",
      message: userMessage("m2", "What is my favourite colour? One word."),
    }));
    const text = await response.text();
    console.log("[composed swap]", JSON.stringify({ tail: text.slice(-600) }));
    expect(text.toLowerCase()).toContain("teal");
  }, 420_000);
});
