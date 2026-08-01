/**
 * ONE Claude Agent SDK turn, port-injected — wave 2 lane E, build list items 4
 * and 5.
 *
 * This module is the SDK loop for `claudeCode()`, and it has TWO homes on
 * purpose:
 *
 *   - inside the box, copied into the template as `/opt/vendo-box/claude-turn.mjs`
 *     (`build-template.mjs`), driven by the supervisor's turn routes;
 *   - on the host, imported from `dist` for `machine: "local"`.
 *
 * One implementation, because the interesting part is identical in both: the
 * projection of `turn.tools.list()` as an in-process MCP server whose every
 * handler round-trips to the HOST, where `turn.tools.call()` executes — one
 * guard, one audit row, one mirror, exactly like `vendo()`. No tool executes
 * box-side. What differs is only `callTool`'s transport (an HTTP bridge in the
 * box, a direct call on the host), which is why it is a port.
 *
 * It therefore imports NOTHING from the workspace: the only imports are the
 * dynamic ones for the SDK and zod, which resolve from `/opt/vendo-box/node_modules`
 * in the box and from the host's optional peer locally. Keep it that way — the
 * emitted `dist/claude-turn.js` is copied verbatim into a machine image.
 *
 * Two permission laws live here (design §3, "claudeCode() specifics"):
 *   - the box is AUTO-ALLOW for its own file/bash work (the box IS the
 *     permission: copies only, no credentials, reality happens at commit), so
 *     those tools are pre-approved and never consult the hook;
 *   - our guard's asks are delivered through the SDK's NATIVE permission hook,
 *     so the co-trained pause-and-explain serves our approval cards. A denial
 *     is `{behavior:"deny"}` — something the model narrates — never a throw.
 */

/** Resolved at RUNTIME, never by tsc: the ~250MB SDK is an optional peer of
 *  `@vendoai/harnesses` and lives in the box image — it must never become a
 *  build-time dependency of this package (the engine's `sdk-seam.ts` uses the
 *  same variable-specifier trick for the same reason). */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The MCP server name our projected tools live under (`mcp__vendo__<tool>`). */
export const VENDO_MCP_SERVER = "vendo";

/** The box's own hands (design §4): a real shell over a workspace COPY. */
export const BOX_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"] as const;

/** Never available to a headless box turn: no user to ask, no egress to spend. */
const DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "AskUserQuestion"];

/** Exactly the three statuses a harness sees (contract §1.1), flattened for the
 *  wire the box speaks. Mapping from `ToolResult` is the host's job. */
export type GuardedResult =
  | { status: "ok"; output: unknown }
  | { status: "denied"; reason: string }
  | { status: "error"; message: string };

/** One `turn.tools.call()`. The ONLY way anything reaches the world. */
export type GuardedCall = (name: string, args: Record<string, unknown>) => Promise<GuardedResult>;

/** A `ToolListing` as the projection needs it (contract §1.1). */
export interface ClaudeTurnTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
}

export type ClaudeTurnEvent =
  | { type: "text"; delta: string }
  | { type: "status"; label: string }
  | { type: "error"; message: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; model?: string }
  /** Not a `HarnessEvent`: the native session ref the caller puts in `turn.state`. */
  | { type: "session"; sessionId: string }
  /** Not a `HarnessEvent` either: an assistant message's own uuid, which is what
   *  `resumeSessionAt` rewinds to. The caller ledgers these so a prefix
   *  truncation can use the SDK's NATIVE rewind instead of paying a re-seed. */
  | { type: "checkpoint"; uuid: string };

export interface ClaudeTurnInput {
  prompt: string;
  /** `Turn.system` — appended to the SDK's own claude_code preset, never replacing
   *  it: the co-training is the reason this harness exists. */
  systemPrompt?: string;
  tools: readonly ClaudeTurnTool[];
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** The native session to continue (`turn.state`). */
  resume?: string;
  /** Resume only up to this message uuid — the SDK's native prefix rewind. */
  resumeAt?: string;
  /** The materialized workspace root on this machine. */
  cwd: string;
  /** Where the SDK keeps its session file, so the caller can ship it out. */
  configDir?: string;
  env: Record<string, string>;
  /** Names the box may run without asking. Defaults to {@link BOX_TOOLS}. */
  allowedBoxTools?: readonly string[];
  callTool: GuardedCall;
  emit: (event: ClaudeTurnEvent) => void;
  signal?: AbortSignal;
  /** Test seam only — production loads the real SDK. */
  sdk?: SdkModule;
}

/** The bits of the SDK this file uses. Narrow on purpose: the real message union
 *  has ~40 members and this file branches on three. */
export interface SdkModule {
  query(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>>;
  tool(name: string, description: string, inputSchema: unknown, handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>): unknown;
  createSdkMcpServer(options: { name: string; version?: string; tools?: unknown[] }): unknown;
}

/** The zod surface the schema translation needs. Deliberately the intersection
 *  of zod 3 and zod 4 — the box installs whatever the SDK's peer resolves to. */
export interface ZodLike {
  string(): AnyZod;
  number(): AnyZod;
  boolean(): AnyZod;
  array(inner: AnyZod): AnyZod;
  any(): AnyZod;
  enum(values: [string, ...string[]]): AnyZod;
}
interface AnyZod {
  optional(): AnyZod;
  describe(text: string): AnyZod;
}

interface JsonSchemaNode {
  type?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

/**
 * JSON Schema → a zod raw shape, because `tool()` takes a raw shape and the
 * interchange we hand every harness is JSON Schema (contract §1.1 amendment).
 * Deliberately partial: our descriptors are flat objects of scalars, arrays and
 * enums, and anything richer degrades to `z.any()` rather than to a schema that
 * lies about what the tool accepts.
 */
export function jsonSchemaToZodShape(schema: unknown, z: ZodLike): Record<string, unknown> {
  const node = (typeof schema === "object" && schema !== null ? schema : {}) as JsonSchemaNode;
  const properties = node.properties;
  if (properties === undefined) return {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const shape: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    let field = leaf(property, z);
    if (typeof property.description === "string") field = field.describe(property.description);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}

function leaf(node: JsonSchemaNode, z: ZodLike): AnyZod {
  if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v) => typeof v === "string")) {
    return z.enum(node.enum as [string, ...string[]]);
  }
  switch (node.type) {
    case "string": return z.string();
    case "number":
    case "integer": return z.number();
    case "boolean": return z.boolean();
    case "array": return z.array(node.items === undefined ? z.any() : leaf(node.items, z));
    default: return z.any();
  }
}

const textResult = (text: string, isError = false): Record<string, unknown> => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const asText = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output ?? null);

/**
 * `canUseTool` is where a projected call actually executes.
 *
 * That looks surprising for one turn and is the only shape that honors the
 * contract: `turn.tools.call()` is ATOMIC (guard + execute + audit + mirror), so
 * it cannot be split into a check for the hook and a run for the handler. Doing
 * it in the hook is what lets a guard denial come back as the SDK's own
 * `{behavior:"deny"}` — the co-trained pause-and-explain — instead of a tool
 * error the model reads as a bug. The handler then returns the result the hook
 * already fetched.
 *
 * Correlation is by name + input rather than by a tool_use id, because
 * `CanUseTool` is not handed one. Two identical concurrent calls would share a
 * slot; they would also share an answer, so the collision is not observable.
 */
function guardedProjection(input: ClaudeTurnInput, z: ZodLike, sdk: SdkModule) {
  const prefix = `mcp__${VENDO_MCP_SERVER}__`;
  const settled = new Map<string, GuardedResult[]>();
  const slot = (name: string, args: unknown): string => `${name} ${JSON.stringify(args ?? {})}`;

  const execute = async (bare: string, args: Record<string, unknown>): Promise<GuardedResult> => {
    try {
      return await input.callTool(bare, args);
    } catch (error) {
      // `call()` never throws by contract; a transport that does is still not
      // allowed to take the turn down.
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };

  const tools = input.tools.map((listed) =>
    sdk.tool(
      listed.name,
      // The title is the consumer-voice name; the model needs both.
      listed.title === undefined ? listed.description : `${listed.title}. ${listed.description}`,
      jsonSchemaToZodShape(listed.inputSchema, z),
      async (args) => {
        const key = slot(listed.name, args);
        const queued = settled.get(key);
        // Normally the hook already ran this exact call. If an SDK build
        // pre-approves MCP tools and never consults the hook, execute here —
        // still exactly one guarded call, and a denial still reads as an error
        // the model can narrate.
        const result = queued !== undefined && queued.length > 0
          ? queued.shift()!
          : await execute(listed.name, args);
        if (queued !== undefined && queued.length === 0) settled.delete(key);
        if (result.status === "ok") return textResult(asText(result.output));
        if (result.status === "denied") return textResult(result.reason, true);
        return textResult(result.message, true);
      },
    ),
  );

  const canUseTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (!name.startsWith(prefix)) {
      // The box IS the permission: its own file/bash work touches a COPY with no
      // credentials on it, and reality happens at commit.
      return { behavior: "allow", updatedInput: args };
    }
    const bare = name.slice(prefix.length);
    const result = await execute(bare, args);
    if (result.status === "denied") {
      // The native denial path: the model explains and moves on. Our approval
      // card is already on the user's screen — the runtime raised it (§1.4).
      return { behavior: "deny", message: result.reason };
    }
    const key = slot(bare, args);
    const queued = settled.get(key);
    if (queued === undefined) settled.set(key, [result]);
    else queued.push(result);
    return { behavior: "allow", updatedInput: args };
  };

  return { tools, canUseTool };
}

/** The SDK's `usage` block, in the `HarnessEvent` vocabulary. */
function usageEvent(raw: unknown, model: string | undefined): ClaudeTurnEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cacheRead = num(usage["cache_read_input_tokens"]);
  const cacheWrite = num(usage["cache_creation_input_tokens"]);
  return {
    type: "usage",
    inputTokens: num(usage["input_tokens"]),
    outputTokens: num(usage["output_tokens"]),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(model === undefined ? {} : { model }),
  };
}

export async function runClaudeTurn(input: ClaudeTurnInput): Promise<void> {
  const sdk = input.sdk ?? ((await import(SDK_PACKAGE)) as unknown as SdkModule);
  const { z } = (await import("zod")) as unknown as { z: ZodLike };

  const { tools, canUseTool } = guardedProjection(input, z, sdk);
  const allowed = [...(input.allowedBoxTools ?? BOX_TOOLS)];

  const options: Record<string, unknown> = {
    cwd: input.cwd,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(input.resume === undefined ? {} : { resume: input.resume }),
    ...(input.resumeAt === undefined ? {} : { resumeSessionAt: input.resumeAt }),
    // Append, never replace: the co-trained Claude Code harness IS the product
    // decision behind this adapter.
    systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPrompt ?? "" },
    // NOT bypassPermissions: the hook is how our guard's asks reach the model.
    permissionMode: "default",
    canUseTool,
    allowedTools: allowed,
    disallowedTools: DISALLOWED_TOOLS,
    mcpServers: { [VENDO_MCP_SERVER]: sdk.createSdkMcpServer({ name: VENDO_MCP_SERVER, version: "1.0.0", tools }) },
    // Never read settings or CLAUDE.md off the materialized workspace: those are
    // the USER's files, and a file cannot be allowed to configure the harness.
    settingSources: [],
    env: input.env,
    ...(input.signal === undefined ? {} : { abortController: abortFor(input.signal) }),
  };

  let model: string | undefined = input.model;
  for await (const message of sdk.query({ prompt: input.prompt, options })) {
    const type = message["type"];
    if (type === "system" && message["subtype"] === "init") {
      const sessionId = message["session_id"];
      if (typeof sessionId === "string") input.emit({ type: "session", sessionId });
      const named = message["model"];
      if (typeof named === "string") model = named;
      continue;
    }
    if (type === "assistant") {
      const uuid = message["uuid"];
      if (typeof uuid === "string") input.emit({ type: "checkpoint", uuid });
      const content = (message["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content;
      for (const block of content ?? []) {
        if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
          input.emit({ type: "text", delta: block["text"] });
        }
      }
      continue;
    }
    if (type === "stream_event") {
      // Real token streaming when the caller asked for partial messages.
      const event = message["event"] as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta"
        && typeof event.delta.text === "string" && event.delta.text !== "") {
        input.emit({ type: "text", delta: event.delta.text });
      }
      continue;
    }
    if (type === "result") {
      const usage = usageEvent(message["usage"], model);
      if (usage !== undefined) input.emit(usage);
      if (message["subtype"] !== "success") {
        // Consumer voice: no subtypes, no internals.
        input.emit({ type: "error", message: "I couldn't finish that one." });
      }
    }
  }
}

function abortFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
