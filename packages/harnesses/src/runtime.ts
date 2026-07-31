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
  VendoError,
  type ApprovalId,
  type AuditEvent,
  type Json,
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
import { AsyncLocalStorage } from "node:async_hooks";
import { validateUpsert, type ToolBridgeOptions } from "@vendoai/agent";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import {
  classifyHistory,
  createTurnState,
  memoryHarnessStateStore,
  type HarnessStateStore,
} from "./harness-state.js";
import { wrapWorkspaceForRender, type RenderSeamOptions } from "./render-seam.js";
import { createTurnTools, type MirrorEvent } from "./turn-tools.js";
import { TextChannel, writeError, writeMirror, writeStatus, writeView } from "./wire.js";

/**
 * `turn.messages` is OURS and read-only (§1). A frozen array still hands out live
 * part objects, so a harness could rewrite canonical history by mutating
 * `parts[0].text` — and the runtime would then persist the harness's edit as the
 * user's own words. Deep-freezing the view closes that; the pristine copy the
 * runtime diffs against closes it even if a host passes an unfrozen structure.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The transcript-only channel. A persisted data part with NO renderer reaches the
 * transcript and never the screen — the transient status part's trick in reverse —
 * which is what lets a subagent receipt exist without opening the closed
 * `HarnessEvent` vocabulary. The runtime owns the write; a harness only reports.
 */
export const VENDO_SUBAGENT_PART = "data-vendo-subagent" as const;

/** Design §6's ~80-token receipt: what the specialist was for, and what it cost. */
export interface HireRecord {
  /** Consumer-voice: what the specialist was hired to accomplish. */
  purpose: string;
  skill?: string;
  /** The specialist's own report back, as the resident received it. */
  summary: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Per-turn sink for hire reports. AsyncLocalStorage rather than a module-level
 * variable because a `harness:` slot is constructed ONCE for the deployment while
 * turns run concurrently — a shared variable would attribute one user's hire to
 * another user's thread.
 */
const hireSink = new AsyncLocalStorage<(record: HireRecord) => void>();

/**
 * Report a hired specialist. Composition wires this into the harness
 * (`vendo({ onHire: reportHire })`); the runtime turns it into an audit row and a
 * transcript receipt. Outside a turn it is a no-op: a harness driven by something
 * other than this runtime must not crash for want of a receipt.
 */
export function reportHire(record: HireRecord): void {
  hireSink.getStore()?.(record);
}

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
  /** The shipped tool-bridge rails composition owns: `toolOutputCap`, the
   *  `preflight` connect gate, and the capability-miss `onCall` hook. The writer
   *  and the per-turn connect-card set are the runtime's to supply. */
  bridge?: Omit<ToolBridgeOptions, "registry" | "ctx" | "guard" | "writer" | "connectCards">;
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
        // A client-sourced history is not trusted history. The shipped rule
        // (`validateUpsert`) is the one that decides what a caller may change:
        // fresh USER messages, and answering a pending approval. Anything else —
        // an assistant message the client authored, a rewritten past turn — is a
        // history-forging attempt and must not reach the model or the store.
        const persisted = [...before];
        for (const message of input.messages) {
          validateUpsert(persisted, message);
          const at = persisted.findIndex((candidate) => candidate.id === message.id);
          if (at === -1) persisted.push(message);
          else persisted[at] = message;
        }
        if (classifyHistory(before, input.messages) !== "arbitrary-edit") {
          carried = await harnessState.get(input.threadId, input.harness.name);
        } else {
          // §1.3: the harness's session no longer describes our conversation.
          await harnessState.clear(input.threadId);
        }
      } catch (error) {
        if (error instanceof VendoError) throw error;
        // An unreadable history is not a licence to hand over a stale session.
        carried = undefined;
      }
      const state = createTurnState(carried);
      // What persistence diffs against. Taken BEFORE the harness runs and never
      // handed out, so a harness cannot make its own edit look like it was
      // already stored.
      const pristine = before === undefined ? [] : before.map((message) => structuredClone(message));

      const signal = input.signal ?? new AbortController().signal;
      let usage: UsageTotals | undefined;
      let failure: { message: string; code?: string } | undefined;
      // Hoisted beside them: onFinish audits what execute collected.
      const hires: HireRecord[] = [];

      const stream = createUIMessageStream<UIMessage>({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
          const text = new TextChannel(writer);
          const mirror = (event: MirrorEvent): void => {
            // Close the open text part first, so a reply that spans tool calls
            // renders as prose, tool, prose instead of collapsing into one block.
            if (event.kind === "call") text.break();
            writeMirror(writer, event);
          };
          const tools = createTurnTools({
            registry: deps.tools,
            guard: deps.guard,
            ctx: input.ctx,
            interactive: input.interactive,
            mirror,
            // The shipped bridge's rails ride along: the writer every
            // `data-vendo-*` part goes to (view, approval, connect, build-failed,
            // citations), `toolOutputCap`, the connect gate, the capability-miss
            // hook, and a FRESH per-turn connect-card dedupe set.
            bridge: { ...deps.bridge, writer, connectCards: new Set<string>() },
            ...(deps.approvalWaitMs === undefined ? {} : { approvalWaitMs: deps.approvalWaitMs }),
          });

          // Every commit that lands a hot-path file goes on screen (§1.6),
          // whichever hands wrote it.
          const workspace = wrapWorkspaceForRender(input.workspace, {
            ...deps.render,
            emit: (_streamId, part) => writeView(writer, part),
          });

          /** For in-process hands, write IS commit: the façade stages writes, so
           *  nothing is durable — or on screen — until this runs. `/user` is
           *  last-write-wins, and a commit with nothing staged is a no-op, so
           *  calling it liberally is cheap. */
          const commit = async (): Promise<void> => {
            try {
              await workspace.commit();
            } catch (error) {
              // A failed commit is the harness's to notice through its next read;
              // it must never take down a turn that already has a reply.
              console.error("[vendo] harness runtime: workspace commit failed", {
                threadId: input.threadId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };

          const recordHire = (record: HireRecord): void => {
            hires.push(record);
            // The receipt: persisted (no `transient`), unrendered by design.
            writer.write({
              type: VENDO_SUBAGENT_PART,
              data: {
                purpose: record.purpose,
                ...(record.skill === undefined ? {} : { skill: record.skill }),
                summary: record.summary,
              },
            } as never);
          };

          const turn: Turn<Options> = {
            // Frozen: ours, read-only. Freezing makes the contract's word true at
            // runtime instead of only at compile time.
            messages: deepFreeze([...input.messages.map((message) => structuredClone(message))]),
            tools: {
              list: () => tools.list(),
              // A workspace tool edit lands the moment it returns, so the
              // skeleton appears on save rather than at turn end.
              call: async (name, args, opts) => {
                const result = await tools.call(name, args, opts);
                await commit();
                return result;
              },
            },
            skills: deps.skills,
            workspace,
            models: input.models,
            state,
            options: input.options as Options,
            signal,
            interactive: input.interactive,
          };

          try {
            // Every hire the harness makes inside this turn lands in THIS turn's
            // records, even from a subagent several awaits deep.
            await hireSink.run(recordHire, async () => {
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
                  // The SCREEN's failure affordance — the same ai-SDK error chunk
                  // `createAgent` raises, so the host renders its banner, its
                  // Retry and its detail line. Splicing the sentence into the
                  // assistant's prose instead would read as the agent talking and
                  // would offer the user nothing to act on.
                  text.break();
                  writeError(writer, event.message);
                  break;
                case "usage":
                  // Audit/metering only — never the screen, never the transcript.
                  usage = addUsage(usage, event);
                  break;
              }
            }
            });
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
            // Turn end lands everything the harness staged and never committed —
            // memory notes, uploads, a plan written straight to the workspace.
            // Inside `execute`, so a view from this commit can still reach the
            // wire; the stream is closed by the time onFinish runs.
            await commit();
            text.end();
            // An approval nobody answered would otherwise stay live-but-dead: its
            // card still on screen, its row still in the pending queue forever.
            // Resolving them denied at turn end is what today's loop does for the
            // approvals a fresh user turn supersedes.
            await abandonUnanswered(deps.guard, input, tools.unansweredApprovals());
            tools.dispose();
          }
        },
        onFinish: async ({ messages }) => {
          await persistTurn(deps.transcript, input, messages, pristine);
          await saveHarnessState(harnessState, input, state.pending());
          await reportRun(deps.guard, input, { usage, failure, hires });
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
/**
 * States that mean "the call was announced and never resolved". A turn that ended
 * mid-call (an abort inside a tool, a harness that stopped awaiting) leaves one,
 * and `convertToModelMessages` turns it into an assistant tool-call with no
 * matching tool-result — which providers reject, corrupting every later turn on
 * the thread.
 *
 * `approval-requested` is deliberately NOT here: a call waiting on a human is
 * legitimately pending, and the client flips it. Only the unreachable states go.
 */
const DANGLING_TOOL_STATES = new Set(["input-streaming", "input-available"]);

const isToolPart = (part: { type: string }): boolean =>
  part.type === "dynamic-tool" || part.type.startsWith("tool-");

/**
 * Enforce the result-pairing invariant instead of racing for it. The shipped loop
 * happens to win this race by a microtask (see abort.test.ts, which pins the
 * timing); dropping the part here makes the guarantee independent of who wins.
 */
function withoutDanglingToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const kept = message.parts.filter(
      (part) => !(isToolPart(part) && DANGLING_TOOL_STATES.has((part as { state?: string }).state ?? "")),
    );
    return kept.length === message.parts.length ? message : { ...message, parts: kept };
  });
}

async function persistTurn(
  transcript: TranscriptStore,
  input: TurnRunInput<unknown>,
  rawMessages: UIMessage[],
  before: readonly UIMessage[] | undefined,
): Promise<void> {
  const messages = withoutDanglingToolCalls(rawMessages);
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
  detail: {
    usage: UsageTotals | undefined;
    failure: { message: string; code?: string } | undefined;
    hires: HireRecord[];
  },
): Promise<void> {
  const row = (body: Json): AuditEvent => ({
    id: mintAuditId(),
    at: new Date().toISOString(),
    kind: "run",
    principal: input.ctx.principal,
    venue: input.ctx.venue,
    presence: input.ctx.presence,
    ...(input.ctx.appId === undefined ? {} : { appId: input.ctx.appId }),
    ...(input.ctx.trigger === undefined ? {} : { trigger: input.ctx.trigger }),
    detail: body,
  });

  const events: AuditEvent[] = [];
  if (detail.usage !== undefined || detail.failure !== undefined) {
    events.push(row({
      harness: input.harness.name,
      ...(detail.usage === undefined ? {} : { usage: detail.usage }),
      ...(detail.failure === undefined ? {} : { error: detail.failure }),
    }));
  }
  // A hire is staffing the guard never saw (only the specialist's guarded CALLS
  // reach it), so it gets its own row: who ran, what for, what it cost.
  for (const hire of detail.hires) {
    events.push(row({
      harness: input.harness.name,
      subagent: {
        purpose: hire.purpose,
        ...(hire.skill === undefined ? {} : { skill: hire.skill }),
        ...(hire.usage === undefined ? {} : { usage: hire.usage }),
      },
    }));
  }

  for (const event of events) {
    try {
      await guard.report(event);
    } catch {
      // A reporting failure cannot change a completed turn's result.
    }
  }
}


/**
 * Resolve the approvals this turn raised and nobody answered. Best-effort and
 * idempotent, exactly like the shipped abandonment path: a failed guard write
 * retries implicitly the next time a turn abandons, and it must never take down a
 * turn that already has a reply.
 */
async function abandonUnanswered(
  guard: Guard,
  input: TurnRunInput<unknown>,
  ids: ApprovalId[],
): Promise<void> {
  if (ids.length === 0 || guard.abandonApprovals === undefined) return;
  try {
    await guard.abandonApprovals(ids, input.ctx);
  } catch {
    // The card is already dead to this turn; queue cleanup retries later.
  }
}
