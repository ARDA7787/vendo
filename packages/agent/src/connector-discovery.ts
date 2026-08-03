import { VENDO_TOOL_TITLES, vendoAuthored, type Json, type RunContext, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";

/**
 * Harness-redesign D3's connector-discovery pair, projected as ordinary tools on
 * the one registry — so the guard, the audit trail and every door treat them
 * exactly like a host tool. There is no privileged side door.
 *
 * These reach the part of the toolset a listing cannot show: connector toolkits
 * materialize lazily, so the broker's catalog is never ON the door's list.
 * `search_connectors` expands a matching toolkit so its tools become callable on
 * the next listing; `list_connections` says which services exist and which this
 * user has actually connected. CONNECTING stays a UI act (the connect card),
 * never a tool call.
 */
export const CONNECTOR_DISCOVERY_TOOLS = ["search_connectors", "list_connections"] as const;

export interface ConnectorDiscoveryPorts {
  /** Search the connector catalog: rank the broker's toolkit index against the
   *  intent, EXPAND the matching toolkits so their tools are callable on the
   *  next listing, and annotate each hit with this subject's connect status.
   *
   *  `ctx` is the CALLER's, handed down from `execute` — never assembled by the
   *  port and never taken from the model's input, because a connection belongs
   *  to a person, not to the deployment. */
  search(query: string, limit: number | undefined, ctx: RunContext): Promise<Json>;
  /** The services this deployment can connect to, each tagged with whether the
   *  caller has connected it. Subject-scoped through `ctx` for the same reason. */
  list(ctx: RunContext): Promise<Json>;
}

/** Hand-written and reviewed in this repo, which is what `vendoAuthored`
 *  records: §12's second mechanical vote is for AI-ASSIGNED labels, and its
 *  verb-shape heuristic — calibrated for extracted `noun_verb` host names —
 *  fails these two closed to `write`, which would make every catalog lookup a
 *  MUTATION downstream (see the same note in vendo-verbs.ts). */
const DESCRIPTORS: ToolDescriptor[] = ([
  {
    name: "search_connectors",
    title: VENDO_TOOL_TITLES.search_connectors,
    description:
      "Search the connector catalog for tools to work with outside services (email, calendars, SaaS). "
      + "Found tools become available to call. Returns each tool's name and connection status.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "list_connections",
    title: VENDO_TOOL_TITLES.list_connections,
    description:
      "List the outside services this product can connect to and whether this user has connected each. "
      + "A service the user has not connected cannot run: say so plainly and point at the connect button.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
] satisfies ToolDescriptor[]).map((descriptor) => vendoAuthored(descriptor));

const fail = (code: string, message: string) => ({ status: "error" as const, error: { code, message } });

/** Both tools are reads, so neither is withheld from an unattended run — the
 *  law filters destructive and external work, and looking at a catalog is
 *  neither. */
export function connectorDiscoveryRegistry(ports: ConnectorDiscoveryPorts): ToolRegistry {
  return {
    async descriptors() {
      return DESCRIPTORS;
    },

    async execute(call, ctx: RunContext) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      try {
        switch (call.tool) {
          case "search_connectors": {
            const query = typeof args["query"] === "string" ? args["query"].trim() : "";
            if (query === "") {
              return fail("validation", "search_connectors needs a query — it never lists the whole catalog");
            }
            const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
            const tools = await ports.search(query, limit, ctx);
            return { status: "ok", output: { tools } as unknown as Json };
          }
          case "list_connections": {
            const connections = await ports.list(ctx);
            return { status: "ok", output: { connections } as unknown as Json };
          }
          default:
            return fail("not-found", `${call.tool} is not a connector-discovery tool`);
        }
      } catch (error) {
        // A port failure is OURS, not the model's, and raw JS text teaches it
        // nothing it can act on while leaking our internals into the transcript.
        // Log the detail for us; hand the model a sentence about what to do.
        console.error(`[vendo] ${call.tool} failed:`, error);
        return fail("error", `${call.tool} could not complete. Try again, or continue without it.`);
      }
    },
  };
}
