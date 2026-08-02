/**
 * The sandbox path — ONE box per conversation, holding ONE live session.
 *
 * **What this file used to be.** A machine POOL with an idle sweep that
 * SNAPSHOTTED before destroying, a resume-ref threaded through `turn.state`, and
 * a token-rotation handshake to re-authenticate a woken supervisor — about 200
 * lines of machinery whose entire purpose was to make a cold start per message
 * cheap. A live session has no cold start per message, so none of it is needed:
 * the box stays up for the conversation and is DESTROYED when it goes idle.
 * A conversation that outlives its box recovers the honest way — a fresh box,
 * files re-materialized from the store, the thread re-seeded from our transcript.
 *
 * That trade is deliberate and it is the cheaper one: a snapshot bought us a
 * resumable session id at the cost of a resume-ref, a rotation protocol, and two
 * race windows. Re-materializing from the store — which is the truth anyway —
 * costs one round trip on the rare message that finds its box gone.
 *
 * **The bridge is inverted.** `SandboxMachine.request()` is the only runtime data
 * path INTO the box, so the host drives: it posts a message, then polls; when the
 * model reaches a projected tool the box parks the ask and hands it out on the
 * next poll; the host runs `turn.tools.call()` and posts the answer back. The box
 * therefore never needs to reach the host at all, which is the strongest possible
 * reading of "the box holds a workspace copy and a token, nothing else" (§9).
 *
 * The cc-native lane MEASURED whether our MCP door could replace that bridge and
 * it cannot — see `packages/vendo/src/mcp-door-parity.e2e.test.ts` and
 * `docs/verification/cc-native/parity-gate.md`. Tools stay in-process.
 *
 * **§1.4, no machine lease while an approval waits.** A guarded call may block up
 * to `APPROVAL_WAIT_MS` for a human tap. The idle timer is armed for that whole
 * window, so a wait that outlives the box's idle budget loses the box — which is
 * the same case as "kill the sandbox mid-turn": the store is untouched and the
 * next message recovers on a fresh box.
 */
import { VendoError } from "@vendoai/core";
import type { GuardedResult } from "@vendoai/apps/claude-turn";
import type { CheckoutFile, SyncFile, TreeState } from "../materialize.js";
import { emptyTree } from "../materialize.js";
import type { SessionMachine, SessionMessage } from "./machine.js";

/** The subset of `SandboxAdapter` (`@vendoai/apps`) a session box needs.
 *  Structural so this subpath never widens the package's type surface.
 *
 *  `snapshot` is deliberately absent now: nothing snapshots a conversation box. */
export interface SandboxAdapterLike {
  create(spec: { template?: string; env: Record<string, string>; allowedDomains?: string[] }): Promise<SandboxMachineLike>;
  destroy(snapshotRef: string): Promise<void>;
}
export interface SandboxMachineLike {
  id: string;
  request(req: { method: string; path: string; port?: number; headers?: Record<string, string>; body?: Uint8Array | string }):
    Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  destroy(): Promise<void>;
}

/** The supervisor's control port, as `box-agent.ts` names it. */
const CONTROL_PORT = 8811;
/** How long a box may sit between messages before it is destroyed. */
export const BOX_IDLE_TTL_MS = 5 * 60_000;
/** The box holds each poll open this long before answering empty. */
const POLL_WAIT_MS = 10_000;
/** One message's bound. Longer than the approval wait, by design. */
const MESSAGE_BUDGET_MS = 15 * 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxEntry {
  machine: SandboxMachineLike;
  /** Minted once, at create. There is no rotation: a box is never restored from
   *  a snapshot, so no supervisor ever comes back holding a stale token. */
  token: string;
  /** Has this box been materialized and had its session opened? */
  warm: boolean;
  /** What this box's disk holds — the sync-back baseline, per conversation. */
  tree: TreeState;
  idle?: ReturnType<typeof setTimeout>;
}

/** One box per THREAD, for as long as the conversation stays warm. Module-scoped
 *  because that is what "the box outlives the turn" means. */
const boxes = new Map<string, BoxEntry>();

const mintToken = (): string => `bxt_${globalThis.crypto.randomUUID()}`;

async function control(
  machine: SandboxMachineLike,
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const answer = await machine.request({
    method: "POST",
    path,
    port: CONTROL_PORT,
    headers: {
      "content-type": "application/json",
      // The box refuses any /session route without it: the ONE thing the machine
      // holds besides a workspace copy and the inference key.
      "x-vendo-box-token": token,
    },
    ...(body === undefined ? {} : { body: encoder.encode(JSON.stringify(body)) }),
  });
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(answer.body));
  } catch {
    json = undefined;
  }
  return { status: answer.status, json };
}

/** Nothing may be destroyed under a box that is about to be used. */
function disarmIdle(entry: BoxEntry): void {
  if (entry.idle !== undefined) clearTimeout(entry.idle);
  entry.idle = undefined;
}

/** Arm the idle timer: destroy, full stop. No snapshot, nothing to publish — the
 *  store already holds every file, and the transcript already holds the thread. */
function armIdle(threadId: string, entry: BoxEntry, idleTtlMs: number): void {
  disarmIdle(entry);
  entry.idle = setTimeout(() => {
    // A timer can outlive its entry (an eviction). Without this it would destroy
    // whichever box holds the slot NOW.
    if (boxes.get(threadId) !== entry) return;
    boxes.delete(threadId);
    void entry.machine.destroy().catch(() => undefined);
  }, idleTtlMs);
  entry.idle.unref?.();
}

export interface BoxMachineOptions {
  sandbox: SandboxAdapterLike;
  threadId: string;
  env: Record<string, string>;
  /** Provider template; defaults to `VENDO_BOX_TEMPLATE`. */
  template?: string;
  /** Test seam; production uses {@link BOX_IDLE_TTL_MS}. */
  idleTtlMs?: number;
}

export async function boxMachine(options: BoxMachineOptions): Promise<SessionMachine> {
  const idleTtlMs = options.idleTtlMs ?? BOX_IDLE_TTL_MS;
  const template = options.template ?? globalThis.process?.env?.["VENDO_BOX_TEMPLATE"];

  /**
   * The credential handoff, and the only one. The box trusts the first hello
   * while it is unclaimed and refuses every other caller after.
   *
   * CLAUDE_CONFIG_DIR is deliberately unset: the SDK's default lives under $HOME,
   * and `/workspace` is the materialized copy — parking the native session there
   * would put machine state inside the user's files.
   */
  const hello = async (machine: SandboxMachineLike, token: string): Promise<boolean> => {
    const { status } = await control(machine, token, "/session/hello", {
      token,
      env: options.env,
    }).catch(() => ({ status: 0, json: undefined }));
    return status === 200;
  };

  const bootBox = async (): Promise<BoxEntry> => {
    const token = mintToken();
    const machine = await options.sandbox.create({
      ...(template === undefined ? {} : { template }),
      env: { ...options.env, VENDO_BOX_TOKEN: token, VENDO_WORKSPACE_ROOT: "/workspace" },
    });
    if (!await hello(machine, token)) {
      await machine.destroy().catch(() => undefined);
      throw new VendoError(
        "sandbox-unavailable",
        "the workspace machine refused the session handshake",
      );
    }
    const fresh: BoxEntry = { machine, token, warm: false, tree: emptyTree() };
    boxes.set(options.threadId, fresh);
    return fresh;
  };

  const existing = boxes.get(options.threadId);
  let entry: BoxEntry | undefined;
  if (existing !== undefined) {
    disarmIdle(existing);
    // PROBE, never assume. A box can be gone without us having asked — a
    // provider reap, an idle policy on their side, a host that slept. Handing
    // that corpse out made the thread fail in a third of a second for the whole
    // process lifetime; only a restart recovered it. `hello` re-presenting the
    // SAME token is the cheapest round trip the box answers.
    if (await hello(existing.machine, existing.token)) {
      entry = existing;
    } else {
      console.error("[vendo] claude-code: the box stopped answering; starting fresh");
      boxes.delete(options.threadId);
      await existing.machine.destroy().catch(() => undefined);
    }
  }
  entry ??= await bootBox();
  const box = entry;

  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const { status, json } = await control(box.machine, box.token, path, body);
    if (status !== 200 && status !== 202) {
      // Carry the box's own sentence: a bare status turns every box problem
      // into a guessing game on the host side.
      const detail = (json as { error?: unknown } | undefined)?.error;
      throw new VendoError(
        "sandbox-unavailable",
        `box ${path} answered ${status}${typeof detail === "string" ? `: ${detail}` : ""}`,
      );
    }
    return (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  };

  return {
    // A warm box carries BOTH the materialized files and the live session.
    carriesSession: box.warm,

    // The frozen layout (§3.1) one level under the box's root.
    pluginPath: "/workspace/host",

    tree: box.tree,

    async materialize(files: readonly CheckoutFile[]) {
      // Chunked by COUNT, which bounds the typical upload body — not a hard
      // byte bound: one large file still travels alone in its chunk, and a
      // BYO files adapter can hold files the proxy may refuse.
      const CHUNK = 24;
      for (let at = 0; at < files.length; at += CHUNK) {
        await request("/session/workspace", {
          reset: at === 0,
          files: files.slice(at, at + CHUNK).map((file) => ({
            path: file.path,
            readOnly: file.readOnly,
            base64: Buffer.from(file.bytes).toString("base64"),
          })),
        });
      }
      if (files.length === 0) await request("/session/workspace", { reset: true, files: [] });
    },

    async collect(paths) {
      const answer = await request("/session/collect", paths === undefined ? {} : { paths });
      const files = Array.isArray(answer["files"]) ? answer["files"] : [];
      return files.flatMap((raw): SyncFile[] => {
        const entryFile = raw as { path?: unknown; base64?: unknown };
        if (typeof entryFile.path !== "string" || typeof entryFile.base64 !== "string") return [];
        return [{ path: entryFile.path, bytes: new Uint8Array(Buffer.from(entryFile.base64, "base64")) }];
      });
    },

    async send(message: SessionMessage) {
      const started = await request("/session/message", {
        prompt: message.prompt,
        systemPrompt: message.systemPrompt,
        tools: message.tools,
        model: message.model,
        effort: message.effort,
        maxTurns: message.maxTurns,
        resume: message.resume,
        reopen: message.reopen,
        pluginPath: message.pluginPath,
        skillNames: message.skillNames,
      });
      // From here on the box holds a session, so a next message on this thread
      // neither re-materializes nor re-seeds.
      box.warm = true;
      const messageId = String(started["messageId"] ?? "");
      const deadline = Date.now() + MESSAGE_BUDGET_MS;
      let cursor = 0;

      for (;;) {
        if (message.signal?.aborted === true) {
          // Interrupt the TURN, not the conversation.
          await request(`/session/${messageId}/interrupt`, {}).catch(() => undefined);
          return;
        }
        if (Date.now() > deadline) {
          await request(`/session/${messageId}/interrupt`, {}).catch(() => undefined);
          throw new VendoError("sandbox-unavailable", "the box message outran its budget");
        }
        const polled = await request(`/session/${messageId}/poll`, { cursor, waitMs: POLL_WAIT_MS });
        for (const event of Array.isArray(polled["events"]) ? polled["events"] : []) {
          const named = event as { type?: unknown; path?: unknown };
          // `wrote` is the native PostToolUse hook coming home. It is NOT a
          // HarnessEvent — it is the signal that replaced the 1.2s file-watch
          // timer, so it goes to the hot-sync callback and never to the user.
          if (named.type === "wrote") {
            message.onFileWritten?.(typeof named.path === "string" ? named.path : undefined);
            continue;
          }
          message.emit(event as never);
        }
        cursor = typeof polled["cursor"] === "number" ? polled["cursor"] : cursor;

        const asks = (Array.isArray(polled["asks"]) ? polled["asks"] : [])
          .filter((ask): ask is { id: string; name: string; args?: unknown } => {
            const candidate = ask as { id?: unknown; name?: unknown };
            return typeof candidate.id === "string" && typeof candidate.name === "string";
          });
        if (asks.length > 0) {
          // §1.4, made real rather than declared: a guarded call may block up to
          // APPROVAL_WAIT_MS for a human tap, and no box may be held immune for
          // that whole window. So the idle timer is ARMED across it — a wait that
          // outlives the idle budget loses the box, and losing it mid-turn is the
          // case the store already survives.
          armIdle(options.threadId, box, idleTtlMs);
          let answered: Array<{ id: string; result: GuardedResult }>;
          try {
            // CONCURRENTLY: the model issued them together, and serializing would
            // queue N approval waits behind each other. One call, one guard
            // verdict, one answer — the box handed each ask out exactly once.
            answered = await Promise.all(asks.map(async (ask) => ({
              id: ask.id,
              result: await message.callTool(ask.name, (ask.args ?? {}) as Record<string, unknown>),
            })));
          } finally {
            disarmIdle(box);
          }
          for (const { id, result } of answered) {
            await request(`/session/${messageId}/answer`, { id, result });
          }
          continue;
        }
        if (polled["done"] === true) return;
      }
    },

    async release() {
      // The box stays up for the next message and is destroyed when the
      // conversation goes quiet. Nothing to carry in `turn.state`: recovery is a
      // fresh box plus the store, not a snapshot ref.
      armIdle(options.threadId, box, idleTtlMs);
    },
  };
}

/** Test + shutdown seam: drop every live box. */
export async function disposeSessionMachines(): Promise<void> {
  const entries = [...boxes.entries()];
  boxes.clear();
  for (const [, entry] of entries) {
    disarmIdle(entry);
    await entry.machine.destroy().catch(() => undefined);
  }
}
