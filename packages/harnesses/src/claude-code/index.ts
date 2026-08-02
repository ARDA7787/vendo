/**
 * `claudeCode()` — the Claude Agent SDK behind the frozen Harness contract.
 *
 * The flagship proof that "who thinks" is swappable: real bash hands over a
 * materialized workspace copy, a native session that survives across turns, and
 * NOT ONE new safety mechanism. Every tool call still lands in
 * `turn.tools.call()` — one guard, one audit row, one mirror, exactly like
 * `vendo()` — because the box's toolset is a projection, never an execution site.
 *
 * The ~250MB SDK never enters the host's node_modules on the sandbox path: it
 * lives in the box image, and this subpath is a thin driver. `machine: "local"`
 * loads it by dynamic import from an OPTIONAL peer.
 *
 * Read with: build contract §1 (the contract), §1.4 (approvals), §3.5
 * (materialization), and design §3 / §8 / §9.
 */
import type {
  Harness,
  HarnessEvent,
  Json,
  ToolListing,
  Turn,
} from "@vendoai/core";
import type { ClaudeTurnEvent, ClaudeTurnTool, GuardedResult } from "@vendoai/apps/claude-turn";
import type { UIMessage } from "ai";
import { z } from "zod";
import { defineHarness } from "../define.js";
import { harnessAdapters } from "../harness-sandbox.js";
import { checkoutWorkspace, type SyncFile } from "../materialize.js";
import { HOT_PATH_FILES } from "../render-seam.js";
import type { TurnMachine } from "./machine.js";
import { localMachine } from "./local.js";
import { boxMachine, type SandboxAdapterLike } from "./box.js";

/** v1 options, exactly (design §3): nothing else until asked. */
export interface ClaudeCodeOptions {
  model?: string;
  effort?: "low" | "medium" | "high";
  maxTurns?: number;
  /** Run the SDK on the host's own server instead of a sandbox. Never default. */
  machine?: "local";
}

/**
 * Declared, then overridable per turn (design §3, "Options are declared").
 *
 * `machine` is deliberately NOT here. It is construction-time only
 * (`claudeCode({ machine: "local" })`): a per-turn override would let a wire
 * caller pull the ~250MB SDK onto the host's own server and run it there, which
 * is a deployment decision, never a request's. The compose gate reads the
 * constructor arg for the same reason.
 */
const optionsSchema = z.object({
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  maxTurns: z.number().int().positive().optional(),
});

/** Host-side dependencies arrive by factory closure (design §3), which is how a
 *  host who did not wire `createVendo({ sandbox })` hands one straight to the
 *  harness. Composition fills the same slot through `provideHarnessAdapters`. */
export interface ClaudeCodeDeps {
  sandbox?: SandboxAdapterLike;
}

/** §3.5's hot paths as SHAPES: the two files that sync mid-turn, under any app —
 *  including one whose id the turn is about to invent. The seam owns the frozen
 *  layout (`hotPathAppId`) and drops anything else that comes back. */
const HOT_WATCH = HOT_PATH_FILES.map((name) => `/user/apps/*/${name}`);
const HOT_SYNC_INTERVAL_MS = 1_200;

/** The recorded v0 inference exception (design §9): a boxed harness must reach a
 *  model to think, and that is the ONLY credential in the machine. */
export function inferenceEnv(): Record<string, string> {
  const source = globalThis.process?.env ?? {};
  const key = source["ANTHROPIC_API_KEY"] ?? source["VENDO_INFERENCE_KEY"];
  const url = source["ANTHROPIC_BASE_URL"] ?? source["VENDO_INFERENCE_URL"];
  const env: Record<string, string> = {
    // Nothing the CLI reaches for on the side: the box's egress is deny-by-default
    // and a stalled telemetry call is a hung turn.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (key !== undefined && key !== "") env["ANTHROPIC_API_KEY"] = key;
  if (url !== undefined && url !== "") {
    env["ANTHROPIC_BASE_URL"] = url.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  return env;
}

/** The plain text of one message, for the re-seed. Parts we cannot render as
 *  prose are deliberately dropped: a re-seed is a summary, never the raw wire. */
function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * What the SDK is asked this turn.
 *
 * Resuming a native session, the SDK already holds everything before now, so the
 * prompt is only what the user just said. Starting fresh — a first turn, or a
 * mid-conversation swap from `vendo()` — the thread is re-seeded from OUR
 * transcript, which is what lets the swap continue the conversation rather than
 * restart it. The truth is always ours (design §3, "Harness state").
 */
export function promptFor(messages: readonly UIMessage[], resuming: boolean): string {
  const latest = messages.at(-1);
  const spoken = latest === undefined ? "" : textOf(latest);
  if (resuming) return spoken === "" ? "Continue." : spoken;
  const earlier = messages.slice(0, -1)
    .map((message) => {
      const text = textOf(message);
      return text === "" ? "" : `${message.role === "user" ? "User" : "You"}: ${text}`;
    })
    .filter((line) => line !== "");
  if (earlier.length === 0) return spoken === "" ? "Continue." : spoken;
  return `Here is the conversation so far, so you can pick it up mid-thread:\n\n${earlier.join("\n\n")}\n\n`
    + `The user now says:\n\n${spoken}`;
}

/** The workspace conventions, appended to `Turn.system`. Consumer-voice law
 *  applies to what the model SAYS; this block is what it needs to KNOW. */
function workspaceBrief(root: string): string {
  return `\n\n## Your workspace\n\n`
    + `Everything you can see is under ${root}. \`user/\` is the person's own space — apps, memory, `
    + `uploaded and generated files — and every change you make there is saved automatically when you finish `
    + `(and immediately, for an app or plan file, so they see it appear). \`host/\` is reference material: read it, never write it. `
    + `\`user/scratch/\` is yours to make a mess in and is never saved.\n\n`
    + `The shell, the editor and the file tools act on a COPY. Anything that touches the real world — the `
    + `product's own actions, the person's data, asking them a question — is a \`vendo\` tool, and those run `
    + `on their behalf with their permission. If one comes back refused, say so plainly and move on; do not `
    + `try to do it another way.\n\n`
    + `Talk to the person like a person: no file paths, no tool names, no code.`;
}

const listingToTool = (listing: ToolListing): ClaudeTurnTool => ({
  name: listing.name,
  title: listing.title,
  description: listing.description,
  ...(listing.inputSchema === undefined ? {} : { inputSchema: listing.inputSchema }),
});

/** `turn.state` — the opaque blob (§1.3). Ours to shape, nobody else's to read. */
interface ClaudeState {
  /** The SDK's native session id, so a next turn resumes instead of re-seeding. */
  sessionId?: string;
  /**
   * The sleeping machine the session lives on (sandbox path only), and the
   * control token its restored memory will still demand. Populated only when a
   * sweep reclaimed the machine MID-turn (a guarded wait outlived the idle
   * TTL) — the ordinary sweep runs after the state was already written, so a
   * process restart normally re-seeds.
   *
   * The token rides here because a woken supervisor keeps the one it slept with,
   * so the next acquire must present it to be allowed to rotate. It is no new
   * exposure: the `ref` beside it already lets its holder wake the machine and
   * read the same workspace.
   */
  resume?: { ref: string; token: string };
  /** How long our transcript was when this session last answered. A SHORTER
   *  transcript next turn is a prefix truncation (§1.3) — the runtime keeps the
   *  state precisely so the harness can rewind natively. */
  covers?: number;
  /** transcript length → the assistant uuid `resumeSessionAt` rewinds to. */
  rewind?: Array<{ at: number; uuid: string }>;
}

/** Enough history to rewind through a plausible run of edits; a session id is
 *  disposable, so an over-old truncation honestly costs a re-seed. */
const REWIND_LEDGER_LIMIT = 24;

/**
 * §1.3's prefix truncation, through the SDK's own rewind.
 *
 * What reaches here with state intact is a REGENERATE or a delete-from-here:
 * a real edit never does, because the runtime already CLEARS the state for one
 * (`classifyHistory` calls a differing overlap an arbitrary edit). Resuming the
 * session unchanged would leave the model remembering exactly what the user
 * removed, so this picks the checkpoint that predates the removal and hands it
 * to `resumeSessionAt`. With no usable checkpoint the session is dropped and
 * the turn re-seeds from our transcript — never wrong, only slower.
 */
export function rewindFor(
  state: ClaudeState,
  messageCount: number,
): { resume?: string; resumeAt?: string } {
  if (state.sessionId === undefined) return {};
  // STRICTLY longer is the only plain resume. `covers` counts the answering
  // turn's INPUTS — its reply lands at transcript index `covers` — so an
  // EQUAL-length history means that reply was thrown away (a regenerate), and
  // resuming unrewound left the model remembering the answer the user just
  // deleted. Rewind past it like any other truncation.
  if (state.covers === undefined || messageCount > state.covers) return { resume: state.sessionId };
  const point = [...(state.rewind ?? [])]
    .filter((entry) => entry.at < messageCount)
    .sort((left, right) => left.at - right.at)
    .at(-1);
  if (point === undefined) return {};
  return { resume: state.sessionId, resumeAt: point.uuid };
}

const readState = (raw: string | undefined): ClaudeState => {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeState) : {};
  } catch {
    return {};
  }
};

/** A callback-driven producer, consumed by the generator that must `yield`. */
function eventQueue<T>() {
  const buffered: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push(value: T) {
      buffered.push(value);
      wake?.();
    },
    close() {
      done = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (buffered.length > 0) yield buffered.shift()!;
        if (done) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

export function claudeCode(
  options: ClaudeCodeOptions & ClaudeCodeDeps = {},
): Harness<ClaudeCodeOptions> {
  const harness: Harness<ClaudeCodeOptions> = defineHarness<ClaudeCodeOptions>({
    name: "claude-code",
    optionsSchema: optionsSchema as never,
    // The factory reads its OWN arg; the compose gate stays dumb (§9: a
    // spawned-CLI harness with no machine to live on is a BOOT error).
    ...(options.machine === "local" ? {} : { requires: { sandbox: true } }),

    async *run(turn: Turn<ClaudeCodeOptions>): AsyncGenerator<HarnessEvent, void, void> {
      // Per-turn options may override the model knobs and NOTHING else: `machine`
      // is read off the constructor, so a request can never move the SDK onto the
      // host's server.
      const resolved = { ...options, ...(turn.options ?? {}), machine: options.machine };
      const state = readState(turn.state.get());
      const checkout = await checkoutWorkspace(turn.workspace);

      let machine: TurnMachine;
      if (resolved.machine === "local") {
        machine = await localMachine({ threadId: threadOf(turn), env: inferenceEnv() });
      } else {
        const sandbox = (options.sandbox ?? harnessAdapters(harness).sandbox) as
          | SandboxAdapterLike
          | undefined;
        if (sandbox === undefined) {
          // On the composed path server.ts now threads the gate-checked
          // adapter into the slot, so gate-pass implies slot-filled there.
          // Still reachable by a host driving the runtime directly without a
          // sandbox — and it has to be loud for the operator and quiet for
          // the user.
          console.error(
            "[vendo] claudeCode() has no sandbox adapter. Hand it one directly — "
            + "`harness: claudeCode({ sandbox: e2bSandbox({ apiKey }) })` — or pass "
            + "`sandbox` into createHarnessTurns so composition fills the slot.",
          );
          yield { type: "error", message: "I can't run right now — this assistant is missing its workspace machine." };
          return;
        }
        machine = await boxMachine({
          sandbox,
          threadId: threadOf(turn),
          env: inferenceEnv(),
          ...(state.resume === undefined ? {} : { resume: state.resume }),
        });
      }

      const events = eventQueue<ClaudeTurnEvent>();
      /** One sync at a time: the façade stages in memory, and two overlapping
       *  commits would race each other's staging set. */
      let syncing: Promise<unknown> = Promise.resolve();
      const serialize = <T>(work: () => Promise<T>): Promise<T> => {
        const next = syncing.then(work, work);
        syncing = next.catch(() => undefined);
        return next;
      };

      // A machine whose disk does not carry the session cannot resume it — asking
      // the SDK to would fail the turn outright, so the honest move is to re-seed
      // from OUR transcript, which is the truth anyway.
      const rewind = machine.carriesSession ? rewindFor(state, turn.messages.length) : {};
      let sessionId = rewind.resume;
      /** The newest assistant uuid this turn produced — the next rewind point. */
      let checkpoint: string | undefined;
      let finished = false;
      let hotTimer: ReturnType<typeof setInterval> | undefined;

      try {
        await machine.materialize(checkout.files);

        // By SHAPE, never by enumeration. Enumerating the hot paths from files
        // that already existed watched nothing at all on the one ask the skeleton
        // exists for — "make me an app" — because a brand-new appId has no
        // directory yet: measured 52.8s of silence against 5.0s when the file
        // happened to pre-exist. The `*` is matched machine-side (§3.1 freezes
        // the layout, so the shape is knowable without the id).
        hotTimer = setInterval(() => {
          if (finished) return;
          void serialize(async () => {
            const hot = await machine.collect(HOT_WATCH);
            await checkout.syncHot(hot);
          }).catch(() => undefined);
        }, HOT_SYNC_INTERVAL_MS);
        hotTimer.unref?.();

        const tools = (await turn.tools.list()).map(listingToTool);
        const running = machine.run({
          prompt: promptFor(turn.messages, sessionId !== undefined),
          systemPrompt: `${turn.system ?? ""}${workspaceBrief(rootHintFor(resolved))}`,
          tools,
          ...(resolved.model === undefined ? {} : { model: resolved.model }),
          ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
          ...(resolved.maxTurns === undefined ? {} : { maxTurns: resolved.maxTurns }),
          ...(rewind.resume === undefined ? {} : { resume: rewind.resume }),
          ...(rewind.resumeAt === undefined ? {} : { resumeAt: rewind.resumeAt }),
          callTool: (name, args) => callGuarded(turn, name, args),
          emit: (event) => events.push(event),
          signal: turn.signal,
        }).then(() => events.close(), (error: unknown) => {
          // The thinker failed; the user hears one plain sentence and the turn
          // still lands whatever work reached the disk.
          console.error("[vendo] claude-code turn failed", error);
          events.push({ type: "error", message: "Something went wrong while I was working on that." });
          events.close();
        });

        for await (const event of events.drain()) {
          if (event.type === "session") {
            sessionId = event.sessionId;
            continue;
          }
          if (event.type === "checkpoint") {
            checkpoint = event.uuid;
            continue;
          }
          yield event;
        }
        await running;
      } finally {
        finished = true;
        if (hotTimer !== undefined) clearInterval(hotTimer);
        // Turn end: the whole writable tree, deletions included (§3.5).
        //
        // A machine that died mid-turn cannot be read back, and an EMPTY read is
        // not the same fact as "the user deleted everything" — syncing one as the
        // other would erase the workspace on every dead box. No read, no sync:
        // the store keeps what it had and the next turn recovers on a fresh
        // machine, which is exactly what the kill-mid-turn law asks for.
        let collected: SyncFile[] | undefined;
        try {
          collected = await machine.collect();
        } catch (error) {
          console.error("[vendo] claude-code could not read the workspace back", error);
        }
        if (collected !== undefined) {
          const files = collected;
          await serialize(() => checkout.syncAll(files)).catch((error: unknown) => {
            console.error("[vendo] claude-code sync-back failed", error);
          });
        }
        let released: { resume?: { ref: string; token: string } } | void = undefined;
        try {
          released = await machine.release();
        } catch {
          // A machine we cannot release is the pool's problem, never the turn's.
        }
        // A rewind that landed replaces the ledger's tail: everything after the
        // rewind point is a branch the session no longer holds.
        const kept = machine.carriesSession
          ? (state.rewind ?? []).filter((entry) => entry.at < turn.messages.length)
          : [];
        const ledger = checkpoint === undefined
          ? kept
          : [...kept, { at: turn.messages.length, uuid: checkpoint }].slice(-REWIND_LEDGER_LIMIT);
        const next: ClaudeState = {
          ...(sessionId === undefined ? {} : { sessionId, covers: turn.messages.length }),
          ...(ledger.length === 0 ? {} : { rewind: ledger }),
          ...(released?.resume === undefined ? {} : { resume: released.resume }),
        };
        if (next.sessionId === undefined) turn.state.clear();
        else turn.state.set(JSON.stringify(next));
      }
    },
  });
  return harness;
}

/** Contract §1.1's three statuses, flattened for the wire the machine speaks. */
async function callGuarded(
  turn: Turn<ClaudeCodeOptions>,
  name: string,
  args: Record<string, unknown>,
): Promise<GuardedResult> {
  const result = await turn.tools.call(name, args as Json);
  if (result.status === "ok") return { status: "ok", output: result.output };
  if (result.status === "denied") return { status: "denied", reason: result.reason };
  return { status: "error", message: result.error.message };
}

/**
 * The thread this turn belongs to — the session machine's pool key.
 *
 * `Turn.threadId` (contract §1, amendment 2026-08-01) is the answer on every
 * composed path — the field is required, so the fallbacks are unreachable from
 * typed callers and exist only for a turn hand-rolled outside the type system:
 * first message id (stable for the life of one thread,
 * unguessable outside it), else a per-turn random key — sharing a machine
 * (and therefore a native session and a workspace copy) between two
 * conversations because both happened to have no identity is the one outcome
 * that must never happen.
 */
function threadOf(turn: Turn<ClaudeCodeOptions>): string {
  const named: unknown = turn.threadId;
  if (typeof named === "string" && named !== "") return named;
  const first = turn.messages[0]?.id;
  if (typeof first === "string" && first !== "") return first;
  return `anon_${globalThis.crypto.randomUUID()}`;
}

/** What the workspace brief calls the root. The box path pins it; local mints a
 *  temp dir, and naming it exactly is not worth a round trip. */
const rootHintFor = (resolved: ClaudeCodeOptions): string =>
  resolved.machine === "local" ? "your working directory" : "/workspace";

