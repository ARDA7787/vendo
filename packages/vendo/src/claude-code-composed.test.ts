/**
 * B2's regression gate — `createVendo({ sandbox, harness: claudeCode() })` must
 * SERVE the turn, not refuse it.
 *
 * The blocker: composition resolved a sandbox adapter, the boot gate approved it,
 * and then `createHarnessTurns` was never handed it — so the harness's machine
 * slot stayed empty and every turn came back "this assistant is missing its
 * workspace machine". Green boot, dead product.
 *
 * Why the existing tests all missed it, and why this file exists:
 *  - `claude-code.test.ts` calls `provideHarnessAdapters` BY HAND, which fills the
 *    slot composition was supposed to fill — the exact seam under test;
 *  - `harness-wire.test.ts` uses scripted harnesses, which need no machine;
 *  - `claude-code-composed.live.test.ts` uses `machine: "local"`, same.
 *
 * So this drives the REAL composition (`createVendo` → `vendo.handler` → the
 * store) with `claudeCode()` in the `harness:` slot and a sandbox adapter in the
 * `sandbox:` slot, and nothing hand-wired between them. Offline: the fake box
 * speaks the REAL box door over an in-process transport and only the SDK loop is
 * scripted.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
// The REAL box door, over a fake transport — a package subpath, not a relative
// climb, because the door is the wire contract between the two blocks.
import { createTurnRoutes } from "@vendoai/apps/box-door";
import { claudeCode } from "@vendoai/harnesses/claude-code";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const principal: Principal = { kind: "user", subject: "user_boxed" };

const cleanups: Array<() => Promise<void>> = [];
const boxRoots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-cc-boxed-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** What the scripted SDK loop inside the box may do. */
interface BoxScript {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  emit: (event: Record<string, unknown>) => void;
}

interface BoxDoor {
  handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
    => Promise<{ status: number; body: unknown }>;
}

/**
 * A stand-in for a real box, adapted from the fake in
 * `packages/harnesses/src/claude-code/claude-code.test.ts` and cut down to what
 * ONE turn touches: `request()` is a transport adapter over the ACTUAL box door
 * (`packages/apps/box/turn-routes.mjs`), so what this exercises is our driver
 * and the composition — never a mock of our own code. The SDK loop is the one
 * thing scripted, because a test cannot run a model.
 */
function fakeSandbox(script: (box: BoxScript) => Promise<void>): {
  create: (spec: { env: Record<string, string> }) => Promise<unknown>;
  resume: (ref: string) => Promise<never>;
  destroy: (ref: string) => Promise<void>;
  creates: number;
} {
  const adapter = {
    creates: 0,
    async create() {
      adapter.creates += 1;
      const root = mkdtempSync(join(tmpdir(), "vendo-fakebox-"));
      boxRoots.push(root);
      const routes = createTurnRoutes({
        root,
        // Unclaimed, so the host's first `/turn/hello` claims it — the same
        // trust-on-first-use a freshly created machine offers.
        token: "",
        env: {},
        runTurn: async (input: BoxScript) => script({ callTool: input.callTool, emit: input.emit }),
      }) as BoxDoor;
      return {
        id: `box_${adapter.creates - 1}`,
        async request(req: {
          method: string;
          path: string;
          headers?: Record<string, string>;
          body?: Uint8Array | string;
        }) {
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(req.method, req.path, req.headers ?? {}, payload);
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
        async snapshot() {
          return "fake:box_0";
        },
        async destroy() { /* nothing outlives the test */ },
      };
    },
    async resume(ref: string): Promise<never> {
      // One turn on a fresh thread never resumes; a call here would mean the
      // driver took a path this test does not describe.
      throw new Error(`unexpected resume of ${ref}`);
    },
    async destroy() { /* no sleeping machine to reap */ },
  };
  return adapter;
}

/** A host tool with an observable side effect, so "the box's call executed
 *  host-side, through our guard" is a fact rather than an inference. */
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
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        calls.push((call.args ?? {}) as Record<string, unknown>);
        return { status: "ok", output: { invoices: [{ id: "inv_1" }] } };
      },
    },
  };
}

const post = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

async function compose(overrides: Record<string, unknown>): Promise<{
  vendo: Vendo;
  store: VendoStore;
  host: ReturnType<typeof hostTools>;
}> {
  const store = await tempStore();
  const host = hostTools();
  const vendo = createVendo({
    // Never reached: the thinker here is the scripted box, not a provider.
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(host.tools);
  return { vendo, store, host };
}

describe("createVendo({ sandbox, harness: claudeCode() })", () => {
  it("serves the turn through the box — the composed adapter fills the machine slot", async () => {
    let answeredInsideTheBox: unknown;
    const sandbox = fakeSandbox(async (box) => {
      answeredInsideTheBox = await box.callTool("maple_invoices_list", {});
      box.emit({ type: "usage", inputTokens: 12, outputTokens: 3 });
      box.emit({ type: "text", delta: "Two invoices are open." });
    });
    const { vendo, store, host } = await compose({ sandbox, harness: claudeCode() });

    const turn = await vendo.handler(post("/threads", {
      threadId: "thr_boxed",
      message: userMessage("m1", "How many invoices are open?"),
    }));
    expect(turn.status).toBe(200);
    const body = await turn.text();

    // B2's exact signature: a deployment that boots green and then refuses every
    // single turn in the consumer's voice.
    expect(body).not.toContain("missing its workspace machine");
    expect(body).toContain("Two invoices are open.");

    // A machine was really taken from the adapter the HOST passed to createVendo,
    // with nothing hand-wired into the harness.
    expect(sandbox.creates).toBe(1);
    // And the box's projected call came back over the bridge and executed on OUR
    // side, through the one guard-bound registry.
    expect(host.calls).toHaveLength(1);
    expect(answeredInsideTheBox).toEqual({ status: "ok", output: { invoices: [{ id: "inv_1" }] } });

    // The audit oracle (`reportRun`): one run row naming the harness that ran,
    // carrying metering and NO failure. The refusal ALSO writes a run row — with
    // an `error` and no `usage` — so this pair is what separates served from
    // refused, and the test cannot pass by accident.
    const { records } = await store.records("vendo_audit")
      .list({ refs: { subject: principal.subject } });
    const runs = records
      .map((record) => record.data as {
        kind?: string;
        detail?: { harness?: string; usage?: unknown; error?: unknown };
      })
      .filter((row) => row.kind === "run");
    expect(runs.map((row) => row.detail?.harness)).toEqual(["claude-code"]);
    expect(runs[0]?.detail?.error).toBeUndefined();
    expect(runs[0]?.detail?.usage).toBeDefined();
  });
});
