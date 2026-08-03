/**
 * Harness-redesign D3's connector-discovery pair, on the ONE registry, through
 * the real composition.
 *
 * The unit tests (packages/agent/src/connector-discovery.test.ts) prove the
 * registry against fake ports. These prove the WIRING: that the tools exist
 * exactly when connectors are configured, that `search_connectors` really
 * expands a lazy toolkit so its tools are listed and callable on the next read,
 * and that both surfaces report the CALLER's connect status rather than the
 * deployment's.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector, ConnectorAccount, ExtractedTool } from "@vendoai/actions";
import type { Principal, RunContext, ToolDescriptor } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_disco" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "s_disco" };

const TOOLS: Record<string, ToolDescriptor> = {
  gmail: {
    name: "gmail_GMAIL_SEND_EMAIL",
    description: "Send an email from the connected Gmail account",
    inputSchema: { type: "object" },
    risk: "write",
  },
  slack: {
    name: "slack_SLACK_POST_MESSAGE",
    description: "Post a message to a Slack channel",
    inputSchema: { type: "object" },
    risk: "write",
  },
};

/** A host tool that ranks HIGH for the connector query below — the crowding
 *  case: without a connector-only filter it would be returned by a tool whose
 *  whole promise is the outside-service catalog. */
const HOST_TOOL: ExtractedTool = {
  name: "host_feed_post",
  description: "Post a message to the customer's own activity feed",
  inputSchema: { type: "object" },
  risk: "write",
  binding: { kind: "route", method: "POST", path: "/api/feed", argsIn: "body" },
};

/** A LAZY broker, the shape the real ones have: nothing loads until a toolkit
 *  is expanded, discovery rides a cheap index, and gmail is already connected
 *  for this subject while slack is not. */
function lazyBroker(): Connector {
  const expanded = new Set<string>();
  const accounts: ConnectorAccount[] = [
    { id: "ca_gmail", connector: "composio", toolkit: "gmail", status: "active" },
  ];
  return {
    name: "composio",
    descriptors: async () => [...expanded].map((toolkit) => TOOLS[toolkit]!),
    execute: async () => ({ status: "ok", output: { sent: true } }),
    toolkitOf: (tool) => Object.keys(TOOLS).find((toolkit) => tool.startsWith(`${toolkit}_`)),
    discoveryIndex: async () => [
      { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail" },
      { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels" },
    ],
    expandToolkits: async (toolkits) => {
      let changed = false;
      for (const toolkit of toolkits) {
        if (TOOLS[toolkit] === undefined || expanded.has(toolkit)) continue;
        expanded.add(toolkit);
        changed = true;
      }
      return changed;
    },
    connections: {
      // Subject-scoped, like every real broker: one principal never observes
      // another's accounts.
      list: async (subject) => (subject === principal.subject ? accounts : []),
      initiate: async () => ({ id: "ca_new", redirectUrl: "https://connect.test/x" }),
      status: async () => accounts[0] ?? null,
      disconnect: async () => undefined,
      listConnectable: async () => [
        { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail" },
        { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels" },
      ],
    },
  };
}

/** ONE real store for the whole file: a PGlite boot costs ~15s and every
 *  composition below is read-only against it, so paying that per test would
 *  make this file the slowest in the suite for no extra coverage. */
let shared: VendoStore | undefined;
beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-disco-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  shared = store;
  cleanups.push(async () => {
    shared = undefined;
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

async function compose(connectors: Connector[], tools: ExtractedTool[] = []): Promise<Vendo> {
  return createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store: shared!,
    connectors,
    tools,
  });
}

const names = async (vendo: Vendo): Promise<string[]> =>
  (await vendo.guardedTools.descriptors(ctx)).map((descriptor) => descriptor.name);

describe("the connector-discovery pair exists exactly when connectors do", () => {
  it("projects search_connectors and list_connections on a connector-backed host", async () => {
    const vendo = await compose([lazyBroker()]);
    const listed = await names(vendo);
    expect(listed).toContain("search_connectors");
    expect(listed).toContain("list_connections");
  });

  it("projects NEITHER when no connector is configured", async () => {
    // An explicit empty array is a choice ("no connectors"), and a host that
    // made it must not be handed discovery machinery with nothing behind it.
    const vendo = await compose([]);
    const listed = await names(vendo);
    expect(listed).not.toContain("search_connectors");
    expect(listed).not.toContain("list_connections");
  });
});

describe("search_connectors", () => {
  it("expands the matching toolkit so its tools are LISTED and callable on the next read", async () => {
    const vendo = await compose([lazyBroker()]);
    // Nothing of slack's is on the surface yet — the catalog is lazy.
    expect(await names(vendo)).not.toContain(TOOLS.slack!.name);

    const outcome = await vendo.guardedTools.execute(
      { id: "d1", tool: "search_connectors", args: { query: "post a message to slack channels" } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    const { tools } = (outcome as { output: { tools: Array<{ name: string; connected?: boolean }> } }).output;
    expect(tools.map((tool) => tool.name)).toContain(TOOLS.slack!.name);

    // The whole point of the tool: the door's next listing carries it, and the
    // guard-bound registry will dispatch it.
    expect(await names(vendo)).toContain(TOOLS.slack!.name);
  });

  it("says which hits this user cannot run yet", async () => {
    // Without it the model burns a turn calling an unconnected service and
    // reads the connect card as a failure.
    const vendo = await compose([lazyBroker()]);
    const outcome = await vendo.guardedTools.execute(
      { id: "d2", tool: "search_connectors", args: { query: "post a message to slack channels" } },
      ctx,
    );
    const { tools } = (outcome as { output: { tools: Array<{ name: string; toolkit?: string; connected?: boolean }> } }).output;
    const slack = tools.find((tool) => tool.name === TOOLS.slack!.name);
    expect(slack).toMatchObject({ toolkit: "slack", connected: false });
  });

  it("returns connector hits ONLY — never a host tool it did not make callable", async () => {
    const vendo = await compose([lazyBroker()], [HOST_TOOL]);
    // The host tool ranks for this very query (it is about posting messages),
    // and the plain tool ranker would return it. It has no connection status,
    // it is already on the door's listing, and on the loadout-bounded surface
    // this tool would not have loaded it — so it is not this tool's answer.
    const outcome = await vendo.guardedTools.execute(
      { id: "d6", tool: "search_connectors", args: { query: "post a message to slack channels" } },
      ctx,
    );
    const { tools } = (outcome as { output: { tools: Array<{ name: string }> } }).output;
    expect(tools.map((tool) => tool.name)).toEqual([TOOLS.slack!.name]);

    // Proof the host tool really was a live, rankable candidate — otherwise this
    // test would pass for the wrong reason.
    expect(await names(vendo)).toContain(HOST_TOOL.name);
  });

  it("refuses an empty query instead of dumping the catalog", async () => {
    const vendo = await compose([lazyBroker()]);
    const outcome = await vendo.guardedTools.execute(
      { id: "d3", tool: "search_connectors", args: { query: "   " } },
      ctx,
    );
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });
});

describe("list_connections", () => {
  it("reports every connectable service with THIS subject's connect status", async () => {
    const vendo = await compose([lazyBroker()]);
    const outcome = await vendo.guardedTools.execute({ id: "d4", tool: "list_connections", args: {} }, ctx);
    expect(outcome.status).toBe("ok");
    const { connections } = (outcome as { output: { connections: Array<{ toolkit: string; connected: boolean }> } }).output;
    expect([...connections].sort((a, b) => (a.toolkit < b.toolkit ? -1 : 1))).toEqual([
      { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail", connected: true },
      { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels", connected: false },
    ]);
  });

  it("answers per PERSON: a stranger with no accounts sees everything unconnected", async () => {
    const vendo = await compose([lazyBroker()]);
    const stranger: RunContext = { ...ctx, principal: { kind: "user", subject: "user_stranger" } };
    const outcome = await vendo.guardedTools.execute({ id: "d5", tool: "list_connections", args: {} }, stranger);
    const { connections } = (outcome as { output: { connections: Array<{ connected: boolean }> } }).output;
    expect(connections.every((row) => row.connected === false)).toBe(true);
  });
});
