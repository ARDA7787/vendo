import { VENDO_TOOL_TITLES, type RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { CONNECTOR_DISCOVERY_TOOLS, connectorDiscoveryRegistry } from "./connector-discovery.js";

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "user_alice" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...overrides,
});

const call = (tool: string, args: unknown) => ({ id: "call_1", tool, args: args as never });

const ports = (overrides = {}) => ({
  search: async () => [{ name: "gmail_GMAIL_SEND_EMAIL", description: "Send an email", risk: "write", toolkit: "gmail", connected: false }],
  list: async () => [{ toolkit: "gmail", label: "Gmail", connected: true }],
  ...overrides,
});

describe("the connector-discovery pair is projected as ordinary tools (D3)", () => {
  it("projects exactly the contracted tool set", async () => {
    const descriptors = await connectorDiscoveryRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.name).sort()).toEqual([...CONNECTOR_DISCOVERY_TOOLS].sort());
  });

  it("labels both as reads — looking at a catalog changes nothing", async () => {
    const descriptors = await connectorDiscoveryRegistry(ports()).descriptors();
    expect(descriptors.every((d) => d.risk === "read")).toBe(true);
  });

  it("reads each title from core's one table, and none of them is an identifier", async () => {
    const descriptors = await connectorDiscoveryRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.title)).toEqual([
      VENDO_TOOL_TITLES.search_connectors,
      VENDO_TOOL_TITLES.list_connections,
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.title, descriptor.name).toBeTruthy();
      expect(descriptor.title, descriptor.name).not.toContain("_");
    }
  });

  it("search_connectors hands the query and limit to the port and returns its rows", async () => {
    const seen: Array<[string, number | undefined, string]> = [];
    const registry = connectorDiscoveryRegistry(ports({
      search: async (query: string, limit: number | undefined, searchCtx: RunContext) => {
        seen.push([query, limit, searchCtx.principal.subject]);
        return [{ name: "slack_SLACK_POST", description: "Post a message", risk: "write", toolkit: "slack", connected: false }];
      },
    }));

    const outcome = await registry.execute(call("search_connectors", { query: "  post to slack  ", limit: 5 }), ctx());

    // The CALLER's ctx reaches the port: a connection belongs to a person.
    expect(seen).toEqual([["post to slack", 5, "user_alice"]]);
    expect(outcome).toEqual({
      status: "ok",
      output: { tools: [{ name: "slack_SLACK_POST", description: "Post a message", risk: "write", toolkit: "slack", connected: false }] },
    });
  });

  it("rejects a blank search rather than dumping the whole catalog", async () => {
    // The connector catalog is 20,000+ tools. A model that can dump it stops
    // searching and starts guessing from the top of the list.
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("search_connectors", { query: " " }), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("list_connections needs no input and reports each service's connect status", async () => {
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("list_connections", {}), ctx());
    expect(outcome).toEqual({
      status: "ok",
      output: { connections: [{ toolkit: "gmail", label: "Gmail", connected: true }] },
    });
  });

  it("does not leak raw JS error text to the model when a port throws", async () => {
    const registry = connectorDiscoveryRegistry(ports({
      search: async () => { throw new TypeError("Cannot read properties of undefined (reading 'toolkit')"); },
    }));

    const outcome = await registry.execute(call("search_connectors", { query: "email" }), ctx());

    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("Cannot read properties");
    expect(JSON.stringify(outcome)).not.toContain("TypeError");
    expect(JSON.stringify(outcome)).toContain("search_connectors");
  });

  it("turns a list-port failure into an honest tool error without leaking the cause", async () => {
    const registry = connectorDiscoveryRegistry(ports({
      list: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); },
    }));
    const outcome = await registry.execute(call("list_connections", {}), ctx());
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
  });

  it("refuses an unknown tool instead of silently succeeding", async () => {
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("connect_service", {}), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
  });

  it("keeps both available in an unattended run — neither is destructive or external work", async () => {
    const projected = await connectorDiscoveryRegistry(ports()).descriptors({ venue: "automation", presence: "away" });
    expect(projected.map((d) => d.name).sort()).toEqual([...CONNECTOR_DISCOVERY_TOOLS].sort());
  });
});
