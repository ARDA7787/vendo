import type { RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createConnectGate } from "./connect-gate.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

const call = { id: "call_1", tool: "gmail_GMAIL_SEND_EMAIL", args: {} };

function innerRegistry() {
  const execute = vi.fn(async () => ({ status: "ok" as const, output: { sent: true } }));
  const registry: ToolRegistry = { descriptors: async () => [], execute };
  return { registry, execute };
}

describe("createConnectGate (criterion 11 — connect check before any guard decision)", () => {
  it("short-circuits an unconnected brokered tool with connect-required; the inner registry never runs", async () => {
    const { registry, execute } = innerRegistry();
    const gate = createConnectGate({
      toolkitOf: async () => ({ connector: "composio", toolkit: "gmail" }),
      isConnected: async () => false,
    });
    const outcome = await gate.bind(registry).execute(call, ctx);
    expect(outcome).toMatchObject({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes the END of a listing scope through — the gate has no opinion about listings", async () => {
    // Same law as the `ctx` forwarding beside it: a decorator that rebuilt the
    // registry shape and swallowed this left the wrapped registry's per-scope
    // expansions shedding by capacity alone (round 6 2026-08-03).
    const released: string[] = [];
    const { registry } = innerRegistry();
    const gate = createConnectGate({
      toolkitOf: async () => undefined,
      isConnected: async () => true,
    });
    gate.bind({ ...registry, releaseListingScope: (scope) => { released.push(scope); } })
      .releaseListingScope?.("mcps_gone");
    expect(released).toEqual(["mcps_gone"]);
  });

  it("delegates connected calls untouched", async () => {
    const { registry, execute } = innerRegistry();
    const gate = createConnectGate({
      toolkitOf: async () => ({ connector: "composio", toolkit: "gmail" }),
      isConnected: async () => true,
    });
    const outcome = await gate.bind(registry).execute(call, ctx);
    expect(outcome).toMatchObject({ status: "ok" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("ignores non-connector tools (no toolkit) — host tools stay ungated", async () => {
    const { registry, execute } = innerRegistry();
    const isConnected = vi.fn(async () => false);
    const gate = createConnectGate({ toolkitOf: async () => undefined, isConnected });
    const outcome = await gate.bind(registry).execute({ ...call, tool: "host_create_invoice" }, ctx);
    expect(outcome).toMatchObject({ status: "ok" });
    expect(isConnected).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails OPEN when the connection lookup is unavailable or throws — the broker path still catches it", async () => {
    for (const isConnected of [async () => undefined, async () => { throw new Error("console down"); }]) {
      const { registry, execute } = innerRegistry();
      const gate = createConnectGate({
        toolkitOf: async () => ({ connector: "composio", toolkit: "gmail" }),
        isConnected: isConnected as () => Promise<boolean | undefined>,
      });
      await expect(gate.bind(registry).execute(call, ctx)).resolves.toMatchObject({ status: "ok" });
      expect(execute).toHaveBeenCalledOnce();
    }
  });

  it("fails OPEN when the toolkit lookup throws", async () => {
    const { registry, execute } = innerRegistry();
    const gate = createConnectGate({
      toolkitOf: async () => { throw new Error("registry not loaded"); },
      isConnected: async () => false,
    });
    await expect(gate.bind(registry).execute(call, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
