import type { Json, RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";

/**
 * Design §4's vendo-verb family, projected as ordinary tools on the one
 * registry — so the guard, the audit trail, and `find_tools` treat them exactly
 * like a host tool. There is no privileged side door.
 *
 * `records_list/put/delete` are deliberately NOT here: they already ship as
 * `vendo_apps_data_list/put/delete` (packages/apps/src/agent-tools.ts), already
 * guarded, and already referenced by name inside stored app documents and the
 * generation prompt. Renaming them would invalidate live documents for no
 * behavioural gain.
 */
export const VENDO_VERB_TOOLS = ["validate", "search_components", "schedule"] as const;

export interface VendoVerbFinding {
  severity: "block" | "warn";
  where?: string;
  message: string;
}

export interface VendoVerbPorts {
  /** Check a document against our catalog and the host's schemas. Returns
   *  findings; it does not throw on a bad document. */
  validate(input: { appId?: string; document?: string }): Promise<{ ok: boolean; findings: VendoVerbFinding[] }>;
  /** Search the component catalog. Returns the SHIPPED catalog vocabulary
   *  (`{ component, description, props?, examples?, remixable? }`). */
  searchComponents(query: string, limit?: number): Promise<Json>;
  /** Arm or change an app's schedule. */
  schedule(input: { appId: string; cron: string }): Promise<Json>;
}

const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "validate",
    title: "Check the app for mistakes",
    description:
      "Check an app document against the component catalog and the host's schemas: does it parse, do the "
      + "tools/components/fields/schedules it references exist, do the types fit. Returns findings to fix. "
      + "Use it after every edit — it is faster and surer than re-reading your own work.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        document: { type: "string" },
      },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "search_components",
    title: "Look up available components",
    description:
      "Search the component catalog by intent to find what you can render. Returns each component's name, "
      + "description, and props. Use it instead of guessing a component name.",
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
    name: "schedule",
    title: "Set when this runs",
    // A write, not a read: arming a schedule changes what happens later, without
    // a person present at the moment it fires.
    description:
      "Set or change when an app's automation runs, as a cron expression. Changing a schedule changes what "
      + "the app does unattended, so say plainly what you are arming.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        cron: { type: "string", minLength: 1 },
      },
      required: ["appId", "cron"],
      additionalProperties: false,
    },
    risk: "write",
  },
];

const fail = (code: string, message: string) => ({ status: "error" as const, error: { code, message } });

/** Every verb is a read or a non-destructive write, so none is withheld from an
 *  unattended run — automations legitimately validate and schedule. The law
 *  filters destructive and external work, which this family has none of. */
export function vendoVerbsRegistry(ports: VendoVerbPorts): ToolRegistry {
  return {
    async descriptors() {
      return DESCRIPTORS;
    },

    async execute(call, _ctx: RunContext) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      try {
        switch (call.tool) {
          case "validate": {
            // A broken document comes back as FINDINGS, never as a tool error: an
            // error reads to the model as "the tool is broken", findings read as
            // "your document is wrong". Only the second one gets fixed.
            const result = await ports.validate({
              ...(typeof args["appId"] === "string" ? { appId: args["appId"] } : {}),
              ...(typeof args["document"] === "string" ? { document: args["document"] } : {}),
            });
            return { status: "ok", output: { ok: result.ok, findings: result.findings } as unknown as Json };
          }
          case "search_components": {
            const query = typeof args["query"] === "string" ? args["query"].trim() : "";
            if (query === "") {
              return fail("validation", "search_components needs a query — it never lists the whole catalog");
            }
            const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
            const components = await ports.searchComponents(query, limit);
            return { status: "ok", output: { components } as unknown as Json };
          }
          case "schedule": {
            const appId = typeof args["appId"] === "string" ? args["appId"] : "";
            const cron = typeof args["cron"] === "string" ? args["cron"] : "";
            if (appId === "" || cron === "") {
              return fail("validation", "schedule needs both an appId and a cron expression");
            }
            return { status: "ok", output: await ports.schedule({ appId, cron }) };
          }
          default:
            return fail("not-found", `${call.tool} is not a Vendo verb`);
        }
      } catch (error) {
        return fail("error", error instanceof Error ? error.message : "unknown error");
      }
    },
  };
}
