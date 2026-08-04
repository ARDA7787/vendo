import { VENDO_TOOL_TITLES, type RunContext, type ToolOutcome } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_DISCOVERY_TOOLS,
  connectorDiscoveryRegistry,
  type ConnectorDiscoveryPorts,
  type ServiceToolMatch,
} from "./connector-discovery.js";

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "user_alice" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...overrides,
});

const call = (tool: string, args: unknown) => ({ id: "call_1", tool, args: args as never });

const MATCH: ServiceToolMatch = {
  slug: "SLACK_SEND_MESSAGE",
  toolkit: "slack",
  description: "Post a message to a Slack channel",
  inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
  connected: false,
  statusMessage: "Connect Slack to use this tool.",
};

const ports = (overrides: Partial<ConnectorDiscoveryPorts> = {}): ConnectorDiscoveryPorts => ({
  find: async () => [MATCH],
  use: async () => ({ status: "ok", output: { ok: true } }),
  list: async () => [{ toolkit: "gmail", label: "Gmail", connected: true }],
  ...overrides,
});

describe("the connector-discovery tools are ordinary tools on the one registry", () => {
  it("projects exactly the contracted tool set", async () => {
    const descriptors = await connectorDiscoveryRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.name).sort()).toEqual([...CONNECTOR_DISCOVERY_TOOLS].sort());
  });

  it("grades the two lookups `read` and the dispatcher `ungraded`", async () => {
    // The dispatcher's descriptor CANNOT carry a real grade: one tool name stands
    // in for a whole third-party catalog. `ungraded` is ask-by-default (#747), and
    // the broker's per-slug grade arrives through the guard's resolveRisk hook.
    const byName = new Map((await connectorDiscoveryRegistry(ports()).descriptors()).map((d) => [d.name, d.risk]));
    expect(byName.get("find_service_tools")).toBe("read");
    expect(byName.get("list_connections")).toBe("read");
    expect(byName.get("use_service_tool")).toBe("ungraded");
  });

  it("reads each title from core's one table, and none of them is an identifier", async () => {
    const descriptors = await connectorDiscoveryRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.title)).toEqual([
      VENDO_TOOL_TITLES.find_service_tools,
      VENDO_TOOL_TITLES.use_service_tool,
      VENDO_TOOL_TITLES.list_connections,
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.title, descriptor.name).toBeTruthy();
      expect(descriptor.title, descriptor.name).not.toContain("_");
    }
  });
});

describe("find_service_tools", () => {
  it("hands the need and the CALLER's ctx to the broker and returns each match inline", async () => {
    const seen: Array<[string, string]> = [];
    const registry = connectorDiscoveryRegistry(ports({
      find: async (need, findCtx) => {
        seen.push([need, findCtx.principal.subject]);
        return [MATCH];
      },
    }));

    const outcome = await registry.execute(call("find_service_tools", { need: "  post to slack  " }), ctx());

    // A connection belongs to a person: the port never assembles its own ctx.
    expect(seen).toEqual([["post to slack", "user_alice"]]);
    // The whole reason the listing never changes: everything needed to CALL the
    // tool — slug and full argument schema — comes back with the match, so
    // finding costs one round trip and no re-list.
    expect(outcome).toEqual({
      status: "ok",
      output: {
        tools: [{
          slug: "SLACK_SEND_MESSAGE",
          toolkit: "slack",
          description: "Post a message to a Slack channel",
          connected: false,
          statusMessage: "Connect Slack to use this tool.",
          inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
        }],
      },
    });
  });

  it("MARKS a match the broker could not produce a schema for", async () => {
    // An absent `inputSchema` field reads as "takes no arguments" and the model
    // then calls the tool with `{}`. It has to be told to ask instead.
    const { inputSchema: _dropped, ...noSchema } = MATCH;
    const outcome = await connectorDiscoveryRegistry(ports({ find: async () => [noSchema] }))
      .execute(call("find_service_tools", { need: "post to slack" }), ctx());

    const [row] = (outcome as { output: { tools: Array<Record<string, unknown>> } }).output.tools;
    expect(row).not.toHaveProperty("inputSchema");
    expect(row!["schemaUnavailable"]).toMatch(/do not guess arguments/i);
  });

  it("rejects a blank need rather than dumping the whole catalog", async () => {
    // The broker's catalog is 20,000+ tools. A model that can dump it stops
    // searching and starts guessing from the top of the list.
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("find_service_tools", { need: " " }), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("bounds the need at both ends — in the schema AND in execute", async () => {
    const [find] = await connectorDiscoveryRegistry(ports()).descriptors();
    const need = (find?.inputSchema as { properties?: { need?: Record<string, unknown> } }).properties?.need;
    expect(need).toMatchObject({ minLength: 1, maxLength: 512 });

    // A schema is advice to the model; execute is what makes it true. A whole
    // pasted document as a "need" is ranked against the broker's whole catalog
    // otherwise.
    let searched = false;
    const outcome = await connectorDiscoveryRegistry(ports({
      find: async () => { searched = true; return []; },
    })).execute(call("find_service_tools", { need: "x".repeat(513) }), ctx());

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(searched).toBe(false);
  });

  it("accepts a need right at the bound", async () => {
    const outcome = await connectorDiscoveryRegistry(ports())
      .execute(call("find_service_tools", { need: "x".repeat(512) }), ctx());
    expect(outcome).toMatchObject({ status: "ok" });
  });
});

describe("use_service_tool", () => {
  it("dispatches the slug and arguments as the caller, and returns the outcome verbatim", async () => {
    const seen: Array<[string, unknown, string]> = [];
    // The passthrough the guard lifts onto the audit row. Rewrapping the outcome
    // here would drop it and the audit row would not name the toolkit.
    const dispatched: ToolOutcome = {
      status: "ok",
      output: { ts: "1712.0" },
      connectorAccount: { connector: "composio", toolkit: "slack" },
    } as ToolOutcome;
    const registry = connectorDiscoveryRegistry(ports({
      use: async (slug, args, useCtx) => {
        seen.push([slug, args, useCtx.principal.subject]);
        return dispatched;
      },
    }));

    const outcome = await registry.execute(
      call("use_service_tool", { slug: " SLACK_SEND_MESSAGE ", arguments: { channel: "#general" } }),
      ctx(),
    );

    expect(seen).toEqual([["SLACK_SEND_MESSAGE", { channel: "#general" }, "user_alice"]]);
    expect(outcome).toBe(dispatched);
  });

  it("treats a missing arguments object as no arguments", async () => {
    // Zero-parameter broker tools exist; requiring the key would make the model
    // invent one.
    const seen: unknown[] = [];
    await connectorDiscoveryRegistry(ports({
      use: async (_slug, args) => { seen.push(args); return { status: "ok", output: {} }; },
    })).execute(call("use_service_tool", { slug: "GMAIL_GET_PROFILE" }), ctx());
    expect(seen).toEqual([{}]);
  });

  it("refuses an unknown slug cleanly and sends the model back to search", async () => {
    // Never a throw, and never a "did you mean" — the broker's 404 carries no
    // suggestion list, so naming a near-miss would be an invention and the model
    // would work its way down a list of guesses.
    const outcome = await connectorDiscoveryRegistry(ports({ use: async () => undefined }))
      .execute(call("use_service_tool", { slug: "SLACK_SEND_MSG" }), ctx());

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    const message = (outcome as { error: { message: string } }).error.message;
    expect(message).toContain("SLACK_SEND_MSG");
    expect(message).toContain("find_service_tools");
    expect(message).not.toMatch(/did you mean/i);
  });

  it("rejects a blank slug before it reaches the broker", async () => {
    let dispatched = false;
    const outcome = await connectorDiscoveryRegistry(ports({
      use: async () => { dispatched = true; return { status: "ok", output: {} }; },
    })).execute(call("use_service_tool", { slug: "  " }), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(dispatched).toBe(false);
  });
});

describe("list_connections", () => {
  it("needs no input and reports each service's connect status", async () => {
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("list_connections", {}), ctx());
    expect(outcome).toEqual({
      status: "ok",
      output: { connections: [{ toolkit: "gmail", label: "Gmail", connected: true }] },
    });
  });
});

describe("no adapter, no tool", () => {
  it("projects list_connections ALONE when nothing can search or dispatch", async () => {
    // The zero-key Cloud default connector's shape: connections, no catalog.
    // A search tool with nothing behind it is worse than no search tool.
    const descriptors = await connectorDiscoveryRegistry({ list: ports().list }).descriptors();
    expect(descriptors.map((d) => d.name)).toEqual(["list_connections"]);
  });

  it("answers a call for an unprojected tool the way it answers a name it never had", async () => {
    const registry = connectorDiscoveryRegistry({ list: ports().list });
    for (const tool of ["find_service_tools", "use_service_tool"]) {
      expect(await registry.execute(call(tool, { need: "x", slug: "x" }), ctx()), tool)
        .toMatchObject({ status: "error", error: { code: "not-found" } });
    }
  });

  it("refuses an unknown tool instead of silently succeeding", async () => {
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("connect_service", {}), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
  });
});

describe("a port failure is ours, not the model's", () => {
  it("does not leak raw JS error text when the search port throws", async () => {
    const outcome = await connectorDiscoveryRegistry(ports({
      find: async () => { throw new TypeError("Cannot read properties of undefined (reading 'toolkit')"); },
    })).execute(call("find_service_tools", { need: "email" }), ctx());

    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("Cannot read properties");
    expect(JSON.stringify(outcome)).not.toContain("TypeError");
    expect(JSON.stringify(outcome)).toContain("find_service_tools");
  });

  it("turns a dispatch failure into an honest tool error without leaking the cause", async () => {
    const outcome = await connectorDiscoveryRegistry(ports({
      use: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); },
    })).execute(call("use_service_tool", { slug: "SLACK_SEND_MESSAGE" }), ctx());
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
  });

  it("turns a list-port failure into an honest tool error without leaking the cause", async () => {
    const outcome = await connectorDiscoveryRegistry(ports({
      list: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); },
    })).execute(call("list_connections", {}), ctx());
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
  });
});
