import { createConnectGate } from "@vendoai/actions";
import type { StoreAdapter, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { describe, expect, it } from "vitest";
import { createByoApprovals } from "./byo-approvals.js";
import { withUniqueToolTitles } from "./duplicate-titles.js";

/**
 * `releaseListingScope` is OPTIONAL, which is exactly what makes it fragile:
 * every decorator that rebuilds `{ descriptors, execute }` from scratch drops it
 * SILENTLY and still type-checks. Dropped, nothing can tell the actions registry
 * a listing scope is finished, so its per-scope expansion sets shed only by the
 * process-global capacity cap — one tenant's sessions evicting another tenant's
 * expanded tools (round 6 2026-08-03).
 *
 * `vendo.guardedTools` — the registry the ai-sdk and mastra packs hand to a
 * foreign loop — shipped with it dropped (round 8). Asserted per WRAPPER and not
 * once on the composed object, because one wrapper losing it is invisible in a
 * chain where the others keep it.
 */
const DESCRIPTOR: ToolDescriptor = {
  name: "host_listInvoices",
  description: "List invoices",
  inputSchema: { type: "object" },
  risk: "read",
  title: "List invoices",
};

function base(): { registry: ToolRegistry; released: string[] } {
  const released: string[] = [];
  return {
    released,
    registry: {
      descriptors: async () => [DESCRIPTOR],
      execute: async () => ({ status: "ok", output: {} }),
      releaseListingScope: (scope) => { released.push(scope); },
    },
  };
}

const guardOf = (): VendoGuard => createGuard({ store: memoryStoreAdapter() });
const storeOf = (): StoreAdapter => memoryStoreAdapter();
const gate = () => createConnectGate({ toolkitOf: async () => undefined, isConnected: async () => true });

/** Every wrapper the shipped composition puts between the door (or a BYO loop)
 *  and the actions registry — see `createVendo`'s `boundTools`/`guardedTools`. */
const WRAPPERS: Array<[string, (tools: ToolRegistry) => ToolRegistry]> = [
  ["guard.bind", (tools) => guardOf().bind(tools)],
  ["connectGate.bind", (tools) => gate().bind(tools)],
  ["withUniqueToolTitles", (tools) => withUniqueToolTitles(tools)],
  ["byoApprovals.registry", (tools) => createByoApprovals({ guard: guardOf(), tools, store: storeOf() }).registry],
];

describe("a released listing scope survives every registry wrapper", () => {
  for (const [name, wrap] of WRAPPERS) {
    it(`${name} forwards the release to the registry underneath`, () => {
      const { registry, released } = base();

      wrap(registry).releaseListingScope?.("mcps_one");

      expect(released).toEqual(["mcps_one"]);
    });
  }

  it("the shipped chain forwards it end to end, guardedTools included", () => {
    const { registry, released } = base();
    const guard = guardOf();
    // Byte-for-byte the composition in `createVendo`: boundTools → the BYO
    // parking registry → the spread `vendo.guardedTools` hands to a foreign loop.
    const boundTools = withUniqueToolTitles(gate().bind(guard.bind(registry)));
    const byoApprovals = createByoApprovals({ guard, tools: boundTools, store: storeOf() });
    const guardedTools: ToolRegistry = {
      ...byoApprovals.registry,
      execute: (call, ctx) => byoApprovals.registry.execute(call, ctx),
    };

    guardedTools.releaseListingScope?.("mcps_chain");

    expect(released).toEqual(["mcps_chain"]);
  });

  it("a registry that keeps nothing per scope is still a valid one to wrap", () => {
    // The method is optional at the BOTTOM too: forwarding must not turn a
    // registry that has nothing to release into a crash for a caller that asks.
    const minimal: ToolRegistry = {
      descriptors: async () => [DESCRIPTOR],
      execute: async () => ({ status: "ok", output: {} }),
    };

    for (const [, wrap] of WRAPPERS) {
      expect(() => wrap(minimal).releaseListingScope?.("mcps_none")).not.toThrow();
    }
  });
});
