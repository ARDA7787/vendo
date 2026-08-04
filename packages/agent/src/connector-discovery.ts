import { VENDO_TOOL_TITLES, vendoAuthored, type Json, type RunContext, type ToolDescriptor, type ToolOutcome, type ToolRegistry } from "@vendoai/core";

/**
 * The connector-discovery tools, projected as ordinary tools on the one registry
 * — so the guard, the audit trail and every door treat them exactly like a host
 * tool. There is no privileged side door.
 *
 * The tool LISTING never changes (connector-discovery design 2026-08-03). A
 * broker's catalog is tens of thousands of tools and no client re-lists mid
 * session, so the catalog is not reached by growing the list: `find_service_tools`
 * returns each match WITH its argument schema, and `use_service_tool` runs one by
 * the broker's own slug. These three names are permanent, and a tool the model
 * found a moment ago is callable on the same turn.
 *
 * CONNECTING stays a UI act (the connect card), never a tool call.
 */
export const CONNECTOR_DISCOVERY_TOOLS = ["find_service_tools", "use_service_tool", "list_connections"] as const;

/** The one dispatcher's name. Exported because composition has to recognise it
 *  to resolve the call's REAL, per-slug risk — see `serviceToolRisk` in the
 *  umbrella's server.ts. */
export const USE_SERVICE_TOOL = "use_service_tool";

/** A need is a phrase ("post a message to slack"), never a document.
 *  Declared in the schema AND enforced in `execute`, for the same reason the
 *  blank-input check is: a schema is advice to the model, and the broker behind
 *  this ranks the phrase against its whole catalog. */
const MAX_NEED_LENGTH = 512;

/** One tool the broker's own search matched. Structurally identical to
 *  `ServiceToolMatch` in @vendoai/actions, restated here because agent may not
 *  depend on actions (layering) — the wire adapts one to the other. */
export interface ServiceToolMatch {
  /** The broker's callable slug, verbatim — what `use_service_tool` takes. */
  slug: string;
  toolkit: string;
  description: string;
  /** JSON Schema for `arguments`. Absent when the broker produced none. */
  inputSchema?: Record<string, unknown>;
  /** Whether THIS caller has an active connection for the toolkit. */
  connected: boolean;
  /** The broker's own sentence about the connection and what to do next. */
  statusMessage?: string;
}

export interface ConnectorDiscoveryPorts {
  /** The broker's OWN search over its whole catalog. Absent when no configured
   *  connector can search — no adapter, no tool, so `find_service_tools` is not
   *  projected at all rather than answering nothing.
   *
   *  `ctx` is the CALLER's, handed down from `execute` — never assembled by the
   *  port and never taken from the model's input, because a connection belongs
   *  to a person, not to the deployment. */
  find?(need: string, ctx: RunContext): Promise<ServiceToolMatch[]>;
  /** Run one of the broker's tools by its own slug, as the caller in `ctx`.
   *  `undefined` means NO connector serves that slug — the model gets a sentence
   *  telling it to search rather than guess a second slug. The outcome is
   *  returned verbatim so its `connectorAccount` passthrough reaches the guard's
   *  audit lift. Paired with {@link find}: both or neither. */
  use?(slug: string, args: unknown, ctx: RunContext): Promise<ToolOutcome | undefined>;
  /** The services this deployment can connect to, each tagged with whether the
   *  caller has connected it. Subject-scoped through `ctx` for the same reason. */
  list(ctx: RunContext): Promise<Json>;
}

/** Hand-written and reviewed in this repo, which is what `vendoAuthored`
 *  records: §12's second mechanical vote is for AI-ASSIGNED labels, and its
 *  verb-shape heuristic — calibrated for extracted `noun_verb` host names —
 *  fails these closed to `write`, which would make every catalog lookup a
 *  MUTATION downstream (see the same note in vendo-verbs.ts). */
const DESCRIPTORS: ToolDescriptor[] = ([
  {
    name: "find_service_tools",
    title: VENDO_TOOL_TITLES.find_service_tools,
    description:
      "Search outside services (email, calendars, SaaS) for a tool that does what you need. "
      + "Each match comes back with the exact slug to pass to use_service_tool, its argument schema, "
      + "and whether this user has connected that service yet.",
    inputSchema: {
      type: "object",
      properties: {
        need: { type: "string", minLength: 1, maxLength: MAX_NEED_LENGTH },
      },
      required: ["need"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: USE_SERVICE_TOOL,
    title: VENDO_TOOL_TITLES.use_service_tool,
    description:
      "Run one outside-service tool. Pass the slug exactly as find_service_tools returned it, "
      + "and arguments matching the schema that came back with it. "
      + "Never guess a slug and never invent arguments — search first.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", minLength: 1 },
        arguments: { type: "object" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    // ONE tool name stands in for a whole third-party catalog, so the descriptor
    // cannot carry a real grade: `ungraded` is ask-by-default (#747), and the
    // per-slug grade the broker actually assigned arrives through the guard's
    // `resolveRisk` hook at call time.
    risk: "ungraded",
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

/** Which port each tool needs. A tool whose port is unset is never projected —
 *  the repo's "no adapter, no tool" rule, applied per tool rather than per
 *  registry, because `list_connections` answers a standalone question that
 *  works on a connector with no search behind it. */
const PORT_FOR: Record<string, keyof ConnectorDiscoveryPorts> = {
  find_service_tools: "find",
  use_service_tool: "use",
  list_connections: "list",
};

const fail = (code: string, message: string) => ({ status: "error" as const, error: { code, message } });
const notOurs = (tool: string) => fail("not-found", `${tool} is not a connector-discovery tool`);

export function connectorDiscoveryRegistry(ports: ConnectorDiscoveryPorts): ToolRegistry {
  const available = DESCRIPTORS.filter((descriptor) => ports[PORT_FOR[descriptor.name]!] !== undefined);

  return {
    async descriptors() {
      return available;
    },

    async execute(call, ctx: RunContext) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      try {
        switch (call.tool) {
          case "find_service_tools": {
            // A tool whose port is unset was never projected, so a call naming
            // it is a call for a tool this registry does not have.
            const find = ports.find;
            if (find === undefined) return notOurs(call.tool);
            const need = typeof args["need"] === "string" ? args["need"].trim() : "";
            if (need === "") {
              return fail("validation", "find_service_tools needs a short phrase saying what you want to do — it never lists the whole catalog");
            }
            if (need.length > MAX_NEED_LENGTH) {
              return fail("validation", `find_service_tools takes a short intent, not a document — keep it under ${MAX_NEED_LENGTH} characters (this one was ${need.length})`);
            }
            const matches = await find(need, ctx);
            return { status: "ok", output: { tools: matches.map(row) as unknown as Json } };
          }
          case USE_SERVICE_TOOL: {
            const use = ports.use;
            if (use === undefined) return notOurs(call.tool);
            const slug = typeof args["slug"] === "string" ? args["slug"].trim() : "";
            if (slug === "") {
              return fail("validation", "use_service_tool needs the slug find_service_tools returned");
            }
            const outcome = await use(slug, args["arguments"] ?? {}, ctx);
            // No connector serves this slug. Naming a near-miss would be an
            // invention — the broker's 404 carries no suggestions — so the only
            // honest next step is to search again.
            return outcome ?? fail("not-found", `No outside-service tool is called "${slug}". Call find_service_tools to get the real slug instead of trying another one.`);
          }
          case "list_connections": {
            const connections = await ports.list(ctx);
            return { status: "ok", output: { connections } as unknown as Json };
          }
          default:
            return notOurs(call.tool);
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

/** One match as the model reads it. A schema the broker could not produce is
 *  MARKED rather than omitted quietly: an absent field reads as "no arguments"
 *  and the model then calls the tool with `{}`. */
function row(match: ServiceToolMatch): Record<string, unknown> {
  return {
    slug: match.slug,
    toolkit: match.toolkit,
    description: match.description,
    connected: match.connected,
    ...(match.statusMessage === undefined ? {} : { statusMessage: match.statusMessage }),
    ...(match.inputSchema === undefined
      ? { schemaUnavailable: "No argument schema came back for this tool. Ask the user what it needs — do not guess arguments." }
      : { inputSchema: match.inputSchema }),
  };
}
