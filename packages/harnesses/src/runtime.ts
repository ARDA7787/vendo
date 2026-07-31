/**
 * The harness runtime — build contract §1.6.
 *
 * It builds the `Turn`, runs any `Harness`, converts the closed `HarnessEvent`
 * vocabulary plus mirrored tool calls into the EXISTING ai-SDK UIMessage stream,
 * persists the transcript one row per message, enforces the frozen routing table,
 * and puts hot-path views on screen.
 *
 * It decides nothing. Orchestration is thinking, and thinking is the harness's.
 */
import {
  type AuditEvent,
  type Guard,
  type Harness,
  type HarnessEvent,
  type Principal,
  type ResolvedModels,
  type RunContext,
  type ThreadId,
  type ToolRegistry,
  type Turn,
  type TurnSkills,
  type WorkspaceFs,
} from "@vendoai/core";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import {
  classifyHistory,
  createTurnState,
  memoryHarnessStateStore,
  type HarnessStateStore,
} from "./harness-state.js";
import { wrapWorkspaceForRender, type RenderSeamOptions } from "./render-seam.js";
import { createTurnTools, type MirrorEvent } from "./turn-tools.js";
import { TextChannel, writeMirror, writeStatus, writeView } from "./wire.js";

/** Build contract §6 — lane D's `threadMessageStore(store)` return value. Typed
 *  structurally so this package never imports @vendoai/store: the store handle
 *  arrives as a composed value. */
export interface TranscriptStore {
  /** One row per message; per-row CAS on `revision` for edits. */
  upsert(principal: Principal, threadId: ThreadId, message: UIMessage, seq: number): Promise<void>;
  /** Reassembled by seq, oldest → newest. */
  list(principal: Principal, threadId: ThreadId): Promise<UIMessage[]>;
}

export interface HarnessRuntimeDeps {
  /** The GUARD-BOUND registry (`VendoGuard.bind(hostTools)`) — the one choke
   *  point every harness's calls pass through, whatever the dialect. */
  tools: ToolRegistry;
  guard: Guard;
  skills: TurnSkills;
  transcript: TranscriptStore;
  /** Defaults to process-lifetime memory: a session id is disposable by contract. */
  harnessState?: HarnessStateStore;
  /** The render seam's optional halves — plan facts and the progressive
   *  query-resolver fill. The seam emits with or without them. */
  render?: Omit<RenderSeamOptions, "emit">;
  /** Test seam only; production uses the frozen APPROVAL_WAIT_MS. */
  approvalWaitMs?: number;
}

export interface TurnRunInput<Options = unknown> {
  harness: Harness<Options>;
  threadId: ThreadId;
  /** The canonical transcript for this turn, INCLUDING the new user message. */
  messages: UIMessage[];
  ctx: RunContext;
  workspace: WorkspaceFs;
  models: ResolvedModels;
  options?: Options;
  /** §1.4 — did the caller prove presence (a click/message/submit)? */
  interactive: boolean;
  signal?: AbortSignal;
}

export interface HarnessRuntime {
  run<Options>(input: TurnRunInput<Options>): Promise<Response>;
}

const mintAuditId = (): string => `aud_${globalThis.crypto.randomUUID()}`;

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

function addUsage(totals: UsageTotals | undefined, event: Extract<HarnessEvent, { type: "usage" }>): UsageTotals {
  const base = totals ?? { inputTokens: 0, outputTokens: 0 };
  const next: UsageTotals = {
    inputTokens: base.inputTokens + event.inputTokens,
    outputTokens: base.outputTokens + event.outputTokens,
  };
  const cacheRead = (base.cacheReadTokens ?? 0) + (event.cacheReadTokens ?? 0);
  if (cacheRead > 0) next.cacheReadTokens = cacheRead;
  const cacheWrite = (base.cacheWriteTokens ?? 0) + (event.cacheWriteTokens ?? 0);
  if (cacheWrite > 0) next.cacheWriteTokens = cacheWrite;
  const model = event.model ?? base.model;
  if (model !== undefined) next.model = model;
  return next;
}

/**
 * §1.5 `error` → screen + transcript + audit. The consumer voice law (§3) makes
 * the text channel the right home for the first two: the user always sees ONE
 * assistant, and a harness `error` is already plain-language with no internals,
 * so it is the assistant speaking honestly rather than a second UI affordance.
 * Nothing new joins the wire format for it.
 */
const HARNESS_FAILED = "Something went wrong on my side, so I stopped.";

export function createHarnessRuntime(deps: HarnessRuntimeDeps): HarnessRuntime {
  const harnessState = deps.harnessState ?? memoryHarnessStateStore();

  return {
    async run<Options>(input: TurnRunInput<Options>): Promise<Response> {
      // §1.3: what the harness may remember depends on how the history moved.
      // A prefix truncation is a native rewind, so its session survives; an
      // arbitrary edit means its session no longer describes our conversation.
      // This snapshot is also what turn-end persistence diffs against — the
      // runtime writes nothing before then, so one read serves both.
      let before: readonly UIMessage[] | undefined;
      let carried: string | undefined;
      try {
        before = await deps.transcript.list(input.ctx.principal, input.threadId);
        if (classifyHistory(before, input.messages) !== "arbitrary-edit") {
          carried = await harnessState.get(input.threadId, input.harness.name);
        }
      } catch {
        // An unreadable history is not a licence to hand over a stale session.
        carried = undefined;
      }
      const state = createTurnState(carried);

      const signal = input.signal ?? new AbortController().signal;
      let usage: UsageTotals | undefined;
      let failure: { message: string; code?: string } | undefined;

      const stream = createUIMessageStream<UIMessage>({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
          const text = new TextChannel(writer);
          const mirror = (event: MirrorEvent): void => writeMirror(writer, event);
          const tools = createTurnTools({
            registry: deps.tools,
            guard: deps.guard,
            ctx: input.ctx,
            interactive: input.interactive,
            mirror,
            ...(deps.approvalWaitMs === undefined ? {} : { approvalWaitMs: deps.approvalWaitMs }),
          });

          const turn: Turn<Options> = {
            // Frozen: ours, read-only. Freezing makes the contract's word true at
            // runtime instead of only at compile time.
            messages: Object.freeze([...input.messages]),
            tools,
            skills: deps.skills,
            // Every hot-path write the harness makes goes on screen (§1.6),
            // whichever hands it used.
            workspace: wrapWorkspaceForRender(input.workspace, {
              ...deps.render,
              emit: (_streamId, part) => writeView(writer, part),
            }),
            models: input.models,
            state,
            options: input.options as Options,
            signal,
            interactive: input.interactive,
          };

          try {
            for await (const event of input.harness.run(turn)) {
              switch (event.type) {
                case "text":
                  text.delta(event.delta);
                  break;
                case "status":
                  writeStatus(writer, event.label);
                  break;
                case "error":
                  failure = { message: event.message, ...(event.code === undefined ? {} : { code: event.code }) };
                  // Screen + transcript, in the assistant's own voice.
                  text.delta(event.message);
                  break;
                case "usage":
                  // Audit/metering only — never the screen, never the transcript.
                  usage = addUsage(usage, event);
                  break;
              }
            }
          } catch (error) {
            // A harness that throws is a bug in the thinker, not in the user's
            // day. The real error goes to the operator's terminal; the user gets
            // a plain sentence, and NOTHING of the internals travels.
            console.error("[vendo] harness run failed", {
              harness: input.harness.name,
              threadId: input.threadId,
              error: error instanceof Error ? error.message : String(error),
            });
            failure = { message: HARNESS_FAILED, code: "harness" };
            text.delta(HARNESS_FAILED);
          } finally {
            text.end();
            tools.dispose();
          }
        },
        onFinish: async ({ messages }) => {
          await persistTurn(deps.transcript, input, messages, before);
          await saveHarnessState(harnessState, input, state.pending());
          await reportRun(deps.guard, input, { usage, failure });
        },
        // The runtime's own last-resort gate. Harness text is already
        // consumer-voice; anything reaching here is a runtime/transport fault.
        onError: (error) => {
          console.error("[vendo] harness stream error:", error);
          return HARNESS_FAILED;
        },
      });

      return createUIMessageStreamResponse({ stream });
    },
  };
}

/**
 * Build contract §6 + the store write law: one row per NEW OR EDITED message,
 * ordered by `seq`, never by timestamp. Re-sending an untouched history costs
 * nothing, so a turn lands O(messages changed) rows — not O(thread), and never
 * O(tokens).
 */
async function persistTurn(
  transcript: TranscriptStore,
  input: TurnRunInput<unknown>,
  messages: UIMessage[],
  before: readonly UIMessage[] | undefined,
): Promise<void> {
  try {
    const unchanged = new Map(
      (before ?? []).map((message) => [message.id, JSON.stringify(message)]),
    );
    for (const [seq, message] of messages.entries()) {
      if (unchanged.get(message.id) === JSON.stringify(message)) continue;
      await transcript.upsert(input.ctx.principal, input.threadId, message, seq);
    }
  } catch (error) {
    // By the time onFinish runs the reply is already on the wire, so throwing
    // here would corrupt a delivered stream. A thread silently vanishing after a
    // successful reply is data loss, so it is named LOUDLY instead.
    console.error("[vendo] harness runtime: transcript persist failed — this turn was NOT saved", {
      threadId: input.threadId,
      subject: input.ctx.principal.subject,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function saveHarnessState(
  store: HarnessStateStore,
  input: TurnRunInput<unknown>,
  pending: { value: string | undefined; dirty: boolean },
): Promise<void> {
  if (!pending.dirty) return;
  try {
    await store.set(input.threadId, input.harness.name, pending.value);
  } catch (error) {
    // `turn.state` is disposable by contract: losing it costs a re-seed, never
    // correctness, so it must never take a delivered turn down with it.
    console.error("[vendo] harness runtime: harness state not saved", {
      threadId: input.threadId,
      harness: input.harness.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One audit row per turn carrying the metering figures and any failure —
 *  `audit ⊇ transcript`, so billing never depends on the story layer. */
async function reportRun(
  guard: Guard,
  input: TurnRunInput<unknown>,
  detail: { usage: UsageTotals | undefined; failure: { message: string; code?: string } | undefined },
): Promise<void> {
  if (detail.usage === undefined && detail.failure === undefined) return;
  const event: AuditEvent = {
    id: mintAuditId(),
    at: new Date().toISOString(),
    kind: "run",
    principal: input.ctx.principal,
    venue: input.ctx.venue,
    presence: input.ctx.presence,
    ...(input.ctx.appId === undefined ? {} : { appId: input.ctx.appId }),
    ...(input.ctx.trigger === undefined ? {} : { trigger: input.ctx.trigger }),
    detail: {
      harness: input.harness.name,
      ...(detail.usage === undefined ? {} : { usage: detail.usage }),
      ...(detail.failure === undefined ? {} : { error: detail.failure }),
    },
  };
  try {
    await guard.report(event);
  } catch {
    // A reporting failure cannot change a completed turn's result.
  }
}
