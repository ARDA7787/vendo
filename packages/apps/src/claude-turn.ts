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
 * It therefore imports NOTHING from the workspace, and — the rule that matters —
 * it never NAMES the Agent SDK. Whoever supplies the machine supplies the SDK:
 * the box door loads it from the machine image, `machine: "local"` loads it from
 * the optional peer that `@vendoai/harnesses` declares. A module that named the
 * package itself was reachable from every composed host's build graph, and a
 * bundler that folds `import(CONST)` then refused to build a host that has no
 * reason to install a ~250MB platform binary. Keep it that way — the emitted
 * `dist/claude-turn.js` is copied verbatim into a machine image.
 *
 * Two permission laws live here (design §3, "claudeCode() specifics"):
 *   - the box is AUTO-ALLOW for its own file/bash work (the box IS the
 *     permission: copies only, no credentials, reality happens at commit), so
 *     those tools are pre-approved and never consult the hook;
 *   - our guard's asks are delivered through the SDK's NATIVE permission hook,
 *     so the co-trained pause-and-explain serves our approval cards. A denial
 *     is `{behavior:"deny"}` — something the model narrates — never a throw.
 */

/** The MCP server name our projected tools live under (`mcp__vendo__<tool>`). */
export const VENDO_MCP_SERVER = "vendo";

/** The box's own hands (design §4): a real shell over a workspace COPY. */
export const BOX_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"] as const;

/** Never available to a headless box turn: no user to ask, no egress to spend.
 *  Redundant with the hook's allow-list ON PURPOSE: `disallowedTools` removes
 *  these from the model's view entirely, so it never plans around them; the
 *  hook denial below is the backstop for an SDK that offers them anyway. */
const DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "AskUserQuestion"];

/** The SDK's subagent door. Allowing the dispatcher grants nothing by itself:
 *  a subagent's inner calls come back through the same permission hook one by
 *  one, each judged on its own name. */
const SUBAGENT_TOOLS = ["Task"];

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

export interface ClaudeSessionInput {
  /** `Turn.system` — appended to the SDK's own claude_code preset, never replacing
   *  it: the co-training is the reason this harness exists. */
  systemPrompt?: string;
  tools: readonly ClaudeTurnTool[];
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** The native session to continue — only meaningful on a machine whose disk
   *  still holds it (`turn.state`). */
  resume?: string;
  /** Resume only up to this message uuid — the SDK's native prefix rewind. */
  resumeAt?: string;
  /** The materialized workspace root on this machine. */
  cwd: string;
  /** `CLAUDE_CONFIG_DIR` included: where the SDK keeps its session file is the
   *  machine's choice, made in the environment and never read back here. */
  env: Record<string, string>;
  /** Names the box may run without asking. Defaults to {@link BOX_TOOLS}. */
  allowedBoxTools?: readonly string[];
  /**
   * A local PLUGIN root for native skill discovery — the SDK reads
   * `<pluginPath>/skills/<name>/SKILL.md`, which is EXACTLY the layout our
   * `/host` mount already lands (`hostSkillFiles` in core). So the host mount IS
   * the plugin: no copy, no translation, no second skills mechanism. Omitted, no
   * plugin is loaded at all.
   */
  pluginPath?: string;
  /**
   * A file this session's work just wrote, from the SDK's NATIVE `PostToolUse`
   * hook. This is what replaces mid-turn file-watch polling: the host syncs on
   * WRITE instead of on a timer. `undefined` means a tool that writes without
   * naming a path (`Bash`), which the host answers with one narrow
   * collect-by-shape rather than a whole-tree read.
   */
  onFileWritten?: (path: string | undefined) => void;
  callTool: GuardedCall;
  emit: (event: ClaudeTurnEvent) => void;
  signal?: AbortSignal;
  /**
   * The Agent SDK module, supplied by whoever supplied the machine: the box door
   * loads it from the image, `machine: "local"` loads it from the optional peer
   * `@vendoai/harnesses` declares (contract build-list item 1). REQUIRED, so
   * this file never names the package and never lands in a host's build graph
   * for it. Tests pass a double.
   */
  sdk: SdkModule;
}

/**
 * One conversation's live session — held open, chat in / stream out.
 *
 * The whole cc-native change is that this object OUTLIVES a turn. `send()` pushes
 * the user's next message into a session that never stopped, which is what makes
 * turn 2 cost nothing and remember everything.
 */
export interface ClaudeSession {
  /** Push one user message in and settle when THAT message's turn is done. */
  send(prompt: string): Promise<void>;
  /**
   * Stop the turn in flight WITHOUT ending the conversation — the user hit stop,
   * they did not close the tab. A live session makes this distinction real:
   * aborting the whole session would throw away everything it remembers.
   */
  interrupt(): Promise<void>;
  /** The SDK's native session id, once it has announced one. */
  sessionId(): string | undefined;
  /** Close the input stream and let the SDK's own loop finish. */
  end(): Promise<void>;
}

/** One user message as the SDK's streaming input wants it. */
interface SessionUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

/** The bits of the SDK this file uses. Narrow on purpose: the real message union
 *  has ~40 members and this file branches on four. */
export interface SdkModule {
  query(params: {
    prompt: string | AsyncIterable<SessionUserMessage>;
    options: Record<string, unknown>;
  }): AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<unknown> };
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

/** The properties a tool actually declares. Nothing else is part of its input. */
const declaredKeys = (schema: unknown): string[] => {
  const node = (typeof schema === "object" && schema !== null ? schema : {}) as JsonSchemaNode;
  return Object.keys(node.properties ?? {});
};

/**
 * The ONE args value for a call: the model's emission projected onto the tool's
 * DECLARED properties.
 *
 * This is what makes exactly-once hold. `z.object(shape)` strips unknown keys and
 * imposes its own key order, so the permission hook (which sees the raw
 * emission) and the MCP handler (which sees the parsed object) were handed
 * DIFFERENT objects for one call — a reordered emission, an invented extra key,
 * or a tool declaring no properties all made the handler miss the hook's queued
 * result and execute the guarded call a SECOND time: two guard verdicts, two
 * audit rows, two executions of one intent. (The effect ledger cannot save this:
 * it keys on a run id an interactive turn does not have.)
 *
 * Normalizing here also means an argument the tool never declared can never
 * reach the guard, which is the honest reading of the descriptor.
 */
function normalizeArgs(schema: unknown, raw: unknown): Record<string, unknown> {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  for (const key of declaredKeys(schema)) {
    if (source[key] !== undefined) args[key] = source[key];
  }
  return args;
}

/** Key-order-independent identity for one call. Both sides compute it from the
 *  SAME normalized args, so the queue can never be missed. */
const callKey = (name: string, args: Record<string, unknown>): string =>
  `${name}\u0000${JSON.stringify(Object.entries(args).sort(([left], [right]) => (left < right ? -1 : 1)))}`;

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
 * Correlation is by name + NORMALIZED input, because `CanUseTool` is not handed a
 * tool_use id. Both sides normalize through the tool's declared schema
 * (`normalizeArgs`), so the two views of one call cannot diverge. Two identical
 * CONCURRENT calls queue two results and consume one each — two intents, two
 * executions, two audit rows, which is correct.
 */
function guardedProjection(input: ClaudeSessionInput, z: ZodLike, sdk: SdkModule) {
  const prefix = `mcp__${VENDO_MCP_SERVER}__`;
  // The hook's ALLOW-list: the box's own hands plus the subagent door. A
  // deny-list here meant every tool nobody had foreseen — say an SDK upgrade
  // shipping a new built-in with egress — was silently allowed; unnamed must
  // mean denied.
  const boxAllowed = new Set<string>([...(input.allowedBoxTools ?? BOX_TOOLS), ...SUBAGENT_TOOLS]);
  const settled = new Map<string, GuardedResult[]>();
  const schemas = new Map(input.tools.map((listed) => [listed.name, listed.inputSchema]));

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
      async (rawArgs) => {
        const args = normalizeArgs(listed.inputSchema, rawArgs);
        const key = callKey(listed.name, args);
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
    rawArgs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (!name.startsWith(prefix)) {
      // ALLOW-LIST, never a deny-list. The box IS the permission for its own
      // hands — file/bash work touches a COPY with no credentials on it, and
      // reality happens at commit — but that argument covers exactly the tools
      // named in {@link boxAllowed}. Anything else (a future SDK built-in with
      // egress, another server's tools) is denied by not being named, instead
      // of allowed by not being foreseen.
      if (boxAllowed.has(name)) return { behavior: "allow", updatedInput: rawArgs };
      return { behavior: "deny", message: `${name} isn't available in this workspace.` };
    }
    const bare = name.slice(prefix.length);
    const args = normalizeArgs(schemas.get(bare), rawArgs);
    const result = await execute(bare, args);
    if (result.status === "denied") {
      // The native denial path: the model explains and moves on. Our approval
      // card is already on the user's screen — the runtime raised it (§1.4).
      return { behavior: "deny", message: result.reason };
    }
    const key = callKey(bare, args);
    const queued = settled.get(key);
    if (queued === undefined) settled.set(key, [result]);
    else queued.push(result);
    // Hand the SDK the normalized args, so the handler is asked about exactly the
    // call the guard already answered.
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

/**
 * A push-driven async iterable — the session's input side.
 *
 * The SDK wants an `AsyncIterable` it can pull from for the life of the
 * conversation; callers arrive one `send()` at a time. Buffering here is what
 * lets a message pushed before the SDK has started pulling still be the first
 * thing it reads.
 */
function messageInbox() {
  const buffered: SessionUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(message: SessionUserMessage) {
      buffered.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *stream(): AsyncGenerator<SessionUserMessage> {
      for (;;) {
        while (buffered.length > 0) yield buffered.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

/**
 * The files a `PostToolUse` hook is worth firing for.
 *
 * `Bash` is here on purpose even though it names no path: `echo … > app.vendo` is
 * a real way to write a hot file, and reporting the write without the path still
 * lets the host do ONE narrow collect-by-shape. That is strictly better than the
 * 1.2s timer this replaces — sync on write, not sync on tick.
 */
const WRITING_TOOLS = "Write|Edit|MultiEdit|NotebookEdit|Bash";

/**
 * Open ONE live session for a whole conversation.
 *
 * `query()` is called exactly once. Its `prompt` is a stream we keep open, so a
 * second user message is a PUSH rather than a cold start: no re-materialize, no
 * resume ref, no re-seed. `send()` settles on its own turn's `result`, which is
 * how the SDK says "this turn is done" while the input stays open.
 */
export function createClaudeSession(input: ClaudeSessionInput): ClaudeSession {
  const sdk = input.sdk;
  const inbox = messageInbox();
  let sessionId: string | undefined;
  let model: string | undefined = input.model;
  /** Settles the `send()` whose turn is currently in flight. */
  let settleTurn: ((error?: unknown) => void) | undefined;
  /** A session that died. Every later `send()` fails with it rather than hanging. */
  let fatal: unknown;

  const onPostToolUse = async (raw: unknown): Promise<Record<string, unknown>> => {
    const hook = raw as { tool_input?: { file_path?: unknown } };
    const written = hook.tool_input?.file_path;
    input.onFileWritten?.(typeof written === "string" ? written : undefined);
    // This hook OBSERVES. Permission lives in `canUseTool`, and a hook that
    // returned a decision here would be a second, quieter permission system.
    return {};
  };

  /** The open `Query`, once it exists — the only thing that can interrupt a turn. */
  let live: { interrupt?: () => Promise<unknown> } | undefined;

  const drain = (async () => {
    const { z } = (await import("zod")) as unknown as { z: ZodLike };
    const { tools, canUseTool } = guardedProjection(input, z, sdk);

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
      allowedTools: [...(input.allowedBoxTools ?? BOX_TOOLS)],
      disallowedTools: DISALLOWED_TOOLS,
      mcpServers: { [VENDO_MCP_SERVER]: sdk.createSdkMcpServer({ name: VENDO_MCP_SERVER, version: "1.0.0", tools }) },
      // Never read settings or CLAUDE.md off the materialized workspace: those are
      // the USER's files, and a file cannot be allowed to configure the harness.
      // This disables FILESYSTEM settings discovery only — `plugins` below is an
      // explicit programmatic list, so native skills survive tenant isolation.
      settingSources: [],
      // Without this the SDK hands us whole assistant blocks and the user watches
      // a still screen for the length of a paragraph.
      includePartialMessages: true,
      env: input.env,
      ...(input.pluginPath === undefined ? {} : {
        // `skipMcpDiscovery`: we own the MCP wiring (the in-process projection),
        // so the engine must not read a plugin's own .mcp.json.
        plugins: [{ type: "local", path: input.pluginPath, skipMcpDiscovery: true }],
        // The SDK's single switch for turning discovered skills ON. A plugin
        // whose skills are never enabled is a directory nobody reads.
        skills: "all",
      }),
      ...(input.onFileWritten === undefined ? {} : {
        hooks: { PostToolUse: [{ matcher: WRITING_TOOLS, hooks: [onPostToolUse] }] },
      }),
      ...(input.signal === undefined ? {} : { abortController: abortFor(input.signal) }),
    };

    const query = sdk.query({ prompt: inbox.stream(), options });
    live = query;
    /** Did the message now being assembled already reach the user as deltas? */
    let streamed = false;
    for await (const message of query) {
      const type = message["type"];
      if (type === "system" && message["subtype"] === "init") {
        const announced = message["session_id"];
        if (typeof announced === "string") {
          sessionId = announced;
          input.emit({ type: "session", sessionId: announced });
        }
        const named = message["model"];
        if (typeof named === "string") model = named;
        continue;
      }
      if (type === "assistant") {
        const uuid = message["uuid"];
        if (typeof uuid === "string") input.emit({ type: "checkpoint", uuid });
        // An `assistant` message is the COMPLETED form of prose that may already
        // have streamed as deltas. Emitting both showed the user every sentence
        // twice (measured live 2026-08-02, once `includePartialMessages` went on).
        // Whichever arrived first wins; the block is still the only source when
        // an SDK build streams nothing, so the fallback stays real.
        if (streamed) {
          streamed = false;
          continue;
        }
        const content = (message["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content;
        for (const block of content ?? []) {
          if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
            input.emit({ type: "text", delta: block["text"] });
          }
        }
        continue;
      }
      if (type === "stream_event") {
        // Real token streaming, now that partial messages are always requested.
        const event = message["event"] as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta"
          && typeof event.delta.text === "string" && event.delta.text !== "") {
          streamed = true;
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
        // THE turn boundary. The input stream stays open; only this message's
        // caller is released.
        const settle = settleTurn;
        settleTurn = undefined;
        settle?.();
      }
    }
  })().catch((error: unknown) => {
    fatal = error;
    const settle = settleTurn;
    settleTurn = undefined;
    settle?.(error);
  });

  /** One turn at a time: the SDK answers pushed messages in order, so two
   *  overlapping sends would each wait on the other's `result`. */
  let queue: Promise<void> = Promise.resolve();

  const sendOne = async (prompt: string): Promise<void> => {
    if (fatal !== undefined) throw fatal;
    const settled = new Promise<void>((resolve, reject) => {
      settleTurn = (error) => (error === undefined ? resolve() : reject(error));
    });
    inbox.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
    await settled;
  };

  return {
    send(prompt) {
      const run = () => sendOne(prompt);
      // `.then(run, run)`: a turn that failed must not wedge the conversation.
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
    async interrupt() {
      // Only meaningful in streaming-input mode, which is the only mode we use.
      // A session too young to have opened its query has nothing to stop.
      await live?.interrupt?.().catch(() => undefined);
    },
    sessionId: () => sessionId,
    async end() {
      inbox.close();
      await drain;
    },
  };
}

function abortFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
