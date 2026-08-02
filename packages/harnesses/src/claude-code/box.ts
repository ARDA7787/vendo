/**
 * The sandbox path — build list items 2, 4, 5 and 8.
 *
 * **One machine per session** (design §9): acquired on the first turn of a
 * thread, reused across its turns, idle-TTL disposed. Built ON the existing
 * `SandboxAdapter` (create/resume/destroy + snapshot) — there is no new adapter
 * interface, because the seam already says everything a session machine needs.
 * When the idle sweep reclaims a machine it SNAPSHOTS first, so the native
 * session file rides the snapshot home and the next turn resumes instead of
 * re-seeding: an idle-TTL'd box never costs a re-seed, and no artifact has to be
 * shipped by hand.
 *
 * **The bridge is inverted.** `SandboxMachine.request()` is the only runtime data
 * path INTO the box, so the host drives: it starts a turn, then polls; when the
 * model reaches a projected tool the box parks the ask and hands it out on the
 * next poll; the host runs `turn.tools.call()` and posts the answer back. The box
 * therefore never needs to reach the host at all, which is the strongest possible
 * reading of "the box holds a workspace copy and a turn-scoped token, nothing
 * else" (§9): there is no outbound credential to hold.
 *
 * **§1.4, no machine lease while an approval waits.** A guarded call may block up
 * to `APPROVAL_WAIT_MS` for a human tap. For that whole window the pool marks the
 * machine UNLEASED, so an idle sweep may reclaim it exactly as it may reclaim an
 * idle one. Reclamation mid-wait is the same case as "kill the sandbox mid-turn":
 * the store is untouched and the next turn recovers on a fresh machine.
 */
import { VendoError } from "@vendoai/core";
import type { GuardedResult } from "@vendoai/apps/internal";
import type { CheckoutFile, SyncFile } from "../materialize.js";
import type { TurnMachine, TurnRequest } from "./machine.js";

/** The subset of `SandboxAdapter` (`@vendoai/apps`) a session machine needs.
 *  Structural so this subpath never widens the package's type surface. */
export interface SandboxAdapterLike {
  create(spec: { template?: string; env: Record<string, string>; allowedDomains?: string[] }): Promise<SandboxMachineLike>;
  resume(snapshotRef: string): Promise<SandboxMachineLike>;
  destroy(snapshotRef: string): Promise<void>;
}
export interface SandboxMachineLike {
  id: string;
  request(req: { method: string; path: string; port?: number; headers?: Record<string, string>; body?: Uint8Array | string }):
    Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  snapshot(): Promise<string>;
  destroy(): Promise<void>;
}

/** The supervisor's control port, as `box-agent.ts` names it. */
const CONTROL_PORT = 8811;
/** How long a reclaimed-for-idleness machine may sit unused. */
export const MACHINE_IDLE_TTL_MS = 5 * 60_000;
/** The box holds each poll open this long before answering empty. */
const POLL_WAIT_MS = 10_000;
/** A whole turn's bound. Longer than the approval wait, by design. */
const TURN_BUDGET_MS = 15 * 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface PoolEntry {
  machine: SandboxMachineLike;
  /**
   * The control token this machine currently accepts.
   *
   * HONEST SCOPE (wave-1 law: no aspirational comments): it is machine-scoped and
   * rotated on every ACQUIRE, warm reuse included — so one token per turn,
   * because a turn acquires exactly once. It is NOT rotated mid-turn, so a turn
   * that spans an approval wait holds one token throughout.
   */
  token: string;
  /** Set while the machine is doing work nobody may reclaim under. */
  leased: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Where the machine went when the sweep took it, and the token it still holds. */
  resume?: SessionRef;
  /** Does this machine's disk carry the native session `turn.state` names? */
  carriesSession: boolean;
}

/** A sleeping machine, and the token its restored memory will still demand. */
export interface SessionRef {
  ref: string;
  token: string;
}

/** Module-scoped on purpose: one machine per THREAD for the life of the process,
 *  which is what "reused across its turns" means. */
const pool = new Map<string, PoolEntry>();

/**
 * Where an idle-swept machine went, per thread. This OUTLIVES its pool entry,
 * and it is what makes "an idle-TTL'd box never costs a re-seed" true: the sweep
 * runs BETWEEN turns, so it has no `turn.state` to write to, and without this the
 * snapshot it takes would be unreachable and every swept session would re-seed.
 *
 * Exactly as durable as the pool itself — a process that restarts loses both,
 * and loses the machine with them, so the re-seed it then pays is honest.
 */
const swept = new Map<string, SessionRef>();

/**
 * The machine's control token.
 *
 * HONEST SCOPE (wave-1 law — no aspirational comments): minted per ACQUIRE and
 * rotated into the box by the handshake — warm reuse included, since the probe
 * that keeps a reaped machine from being handed out IS that handshake. A turn
 * acquires exactly once, so this is one token per turn. Nothing rotates
 * mid-turn, so design §9's "turn-scoped" now holds at turn granularity and no
 * finer.
 */
const mintToken = (): string => `bxt_${globalThis.crypto.randomUUID()}`;

async function control(
  machine: SandboxMachineLike,
  presented: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const answer = await machine.request({
    method,
    path,
    port: CONTROL_PORT,
    headers: {
      "content-type": "application/json",
      // The box refuses any /turn route without it: the ONE thing the machine
      // holds besides a workspace copy and the inference key.
      "x-vendo-box-token": presented,
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

/** Arm the idle sweep: snapshot, then destroy. The ref is what a later turn
 *  resumes, so the native session comes back with the disk. */
function armIdle(threadId: string, entry: PoolEntry, idleTtlMs: number): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    void (async () => {
      // A timer can outlive its entry (an eviction, a failed handshake). Without
      // this it would delete whichever machine holds the slot NOW and publish a
      // stale snapshot ref for it.
      if (pool.get(threadId) !== entry) return;
      if (entry.leased) return;
      pool.delete(threadId);
      try {
        const ref = await entry.machine.snapshot();
        // The snapshot await is a window: a new machine may have claimed the
        // thread meanwhile. Publishing the OLD box's ref then would hand the
        // next process restart a one-turn-stale session. The newer machine
        // owns the swept slot; this sweep only destroys its own box.
        if (!pool.has(threadId)) {
          // The token the sleeping box's MEMORY still holds travels with the
          // ref: a resume restores the supervisor, so the next acquire has to
          // present this one to be allowed to rotate to a fresh one.
          entry.resume = { ref, token: entry.token };
          swept.set(threadId, entry.resume);
        }
      } catch {
        // No snapshot means the next turn starts fresh and re-seeds from our
        // transcript — disposable by contract. Same window guard: never drop
        // a ref a newer machine may have published.
        if (!pool.has(threadId)) swept.delete(threadId);
      }
      await entry.machine.destroy().catch(() => undefined);
    })();
  }, idleTtlMs);
  entry.timer.unref?.();
}

export interface BoxMachineOptions {
  sandbox: SandboxAdapterLike;
  threadId: string;
  env: Record<string, string>;
  /** The sleeping machine a previous idle sweep left behind (`turn.state`). */
  resume?: SessionRef;
  /** Provider template; defaults to `VENDO_BOX_TEMPLATE`. */
  template?: string;
  /** Test seam; production uses {@link MACHINE_IDLE_TTL_MS}. */
  idleTtlMs?: number;
}

export async function boxMachine(options: BoxMachineOptions): Promise<TurnMachine> {
  const idleTtlMs = options.idleTtlMs ?? MACHINE_IDLE_TTL_MS;
  const template = options.template ?? globalThis.process?.env?.["VENDO_BOX_TEMPLATE"];

  /** Boot a brand-new machine. Its disk carries no native session.
   *
   *  CLAUDE_CONFIG_DIR is deliberately unset: the SDK's default lives under $HOME,
   *  and `/workspace` is emptied and re-materialized at the start of every turn —
   *  parking the native session there would delete it on turn 2, which is the one
   *  thing the session machine exists to prevent. */
  const createMachine = async (token: string): Promise<SandboxMachineLike> =>
    await options.sandbox.create({
      ...(template === undefined ? {} : { template }),
      env: { ...options.env, VENDO_BOX_TOKEN: token, VENDO_WORKSPACE_ROOT: "/workspace" },
    });

  /**
   * The handshake, and the ONLY credential handoff. It ROTATES the token: the
   * caller presents whatever the machine currently accepts and names the token it
   * must accept from now on.
   *
   * Rotation is the whole fix for resume. A snapshot restores the supervisor's
   * MEMORY, so a woken box still demands the token it held when it went to sleep,
   * while the host mints a fresh one per acquire — presenting the new token to a
   * woken box is a 401, and every thread idle past the TTL was locked out on its
   * next message.
   */
  const hello = async (
    machine: SandboxMachineLike,
    presented: string,
    next: string,
  ): Promise<boolean> => {
    const { status } = await control(machine, presented, "POST", "/turn/hello", {
      token: next,
      env: options.env,
    }).catch(() => ({ status: 0, json: undefined }));
    return status === 200;
  };

  /** Wake or boot a machine for this thread, from the swept ref if there is one. */
  const acquireCold = async (): Promise<PoolEntry> => {
    // The sweep's own ref first: it is newer than anything a caller could carry.
    const carried = swept.get(options.threadId) ?? options.resume;
    const token = mintToken();
    let machine: SandboxMachineLike | undefined;
    let presented = token;
    let carriesSession = false;
    if (carried !== undefined) {
      swept.delete(options.threadId);
      try {
        machine = await options.sandbox.resume(carried.ref);
        presented = carried.token;
        carriesSession = true;
      } catch {
        // A snapshot the provider dropped is a re-seed, not a failure.
        machine = undefined;
      }
    }
    if (machine === undefined) machine = await createMachine(token);

    let ok = await hello(machine, presented, token);
    if (!ok && carriesSession) {
      // The woken box will not rotate — its memory holds a token we no longer
      // have. Abandon it rather than strand the thread: a fresh machine costs a
      // re-seed, and `carriesSession: false` is what tells the harness to pay it
      // instead of resuming a session id no disk holds.
      console.error("[vendo] claude-code: a woken workspace machine refused the token rotation; starting fresh");
      await machine.destroy().catch(() => undefined);
      machine = await createMachine(token);
      carriesSession = false;
      ok = await hello(machine, token, token);
    }
    if (!ok) {
      await machine.destroy().catch(() => undefined);
      throw new VendoError(
        "sandbox-unavailable",
        "the workspace machine refused the turn handshake",
      );
    }
    const fresh: PoolEntry = { machine, token, leased: true, carriesSession };
    pool.set(options.threadId, fresh);
    return fresh;
  };

  const existing = pool.get(options.threadId);
  let entry: PoolEntry | undefined;
  if (existing !== undefined) {
    if (existing.timer !== undefined) clearTimeout(existing.timer);
    existing.timer = undefined;
    // PROBE, never assume. A pooled machine can be gone without us having asked
    // for it — a provider reap, an idle policy on their side, a host that slept.
    // Handing that corpse out made the thread fail in a third of a second for
    // the whole process lifetime; only a restart recovered it. The rotation
    // handshake IS the probe: it is the cheapest round trip the box answers, and
    // rotating on every acquire is what design §9's turn-scoped token asks for
    // anyway.
    const rotated = mintToken();
    if (await hello(existing.machine, existing.token, rotated)) {
      existing.token = rotated;
      // A machine that answered has served this thread, so whatever session the
      // last turn wrote is still on its disk — warm reuse carries it.
      existing.carriesSession = true;
      entry = existing;
    } else {
      // Evict, then fall through to the swept-ref/fresh path. A fresh machine
      // costs a re-seed (`carriesSession: false` there tells the harness to pay
      // it) and the store already survived the death, so the recovered turn is
      // correct — only slower.
      console.error("[vendo] claude-code: the pooled workspace machine stopped answering; starting fresh");
      pool.delete(options.threadId);
      await existing.machine.destroy().catch(() => undefined);
    }
  }
  entry ??= await acquireCold();
  entry.leased = true;

  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const { status, json } = await control(entry.machine, entry.token, "POST", path, body);
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
    carriesSession: entry.carriesSession,

    async materialize(files: readonly CheckoutFile[]) {
      // Chunked so one oversized upload cannot blow the proxy's body limit.
      const CHUNK = 24;
      for (let at = 0; at < files.length; at += CHUNK) {
        await request("/turn/workspace", {
          reset: at === 0,
          files: files.slice(at, at + CHUNK).map((file) => ({
            path: file.path,
            readOnly: file.readOnly,
            base64: Buffer.from(file.bytes).toString("base64"),
          })),
        });
      }
      if (files.length === 0) await request("/turn/workspace", { reset: true, files: [] });
    },

    async collect(paths) {
      const answer = await request("/turn/collect", paths === undefined ? {} : { paths });
      const files = Array.isArray(answer["files"]) ? answer["files"] : [];
      return files.flatMap((raw): SyncFile[] => {
        const entryFile = raw as { path?: unknown; base64?: unknown };
        if (typeof entryFile.path !== "string" || typeof entryFile.base64 !== "string") return [];
        return [{ path: entryFile.path, bytes: new Uint8Array(Buffer.from(entryFile.base64, "base64")) }];
      });
    },

    async run(turnRequest: TurnRequest) {
      const started = await request("/turn/start", {
        prompt: turnRequest.prompt,
        systemPrompt: turnRequest.systemPrompt,
        tools: turnRequest.tools,
        model: turnRequest.model,
        effort: turnRequest.effort,
        maxTurns: turnRequest.maxTurns,
        resume: turnRequest.resume,
        resumeAt: turnRequest.resumeAt,
      });
      const turnId = String(started["turnId"] ?? "");
      const deadline = Date.now() + TURN_BUDGET_MS;
      let cursor = 0;

      for (;;) {
        if (turnRequest.signal?.aborted === true) {
          await request(`/turn/${turnId}/abort`, {}).catch(() => undefined);
          return;
        }
        if (Date.now() > deadline) {
          await request(`/turn/${turnId}/abort`, {}).catch(() => undefined);
          throw new VendoError("sandbox-unavailable", "the box turn outran its budget");
        }
        const polled = await request(`/turn/${turnId}/poll`, { cursor, waitMs: POLL_WAIT_MS });
        for (const event of Array.isArray(polled["events"]) ? polled["events"] : []) {
          turnRequest.emit(event as never);
        }
        cursor = typeof polled["cursor"] === "number" ? polled["cursor"] : cursor;

        const asks = (Array.isArray(polled["asks"]) ? polled["asks"] : [])
          .filter((ask): ask is { id: string; name: string; args?: unknown } => {
            const candidate = ask as { id?: unknown; name?: unknown };
            return typeof candidate.id === "string" && typeof candidate.name === "string";
          });
        if (asks.length > 0) {
          // §1.4, made real rather than declared: a guarded call may block up to
          // APPROVAL_WAIT_MS for a human tap, and no machine lease may outlive
          // that. So the lease is DROPPED and the idle sweep ARMED for the whole
          // window — a wait that outlives the machine's idle budget loses the
          // machine, and losing it mid-turn is the case the store already
          // survives (nothing syncs, the next turn recovers on a fresh one).
          entry.leased = false;
          armIdle(options.threadId, entry, idleTtlMs);
          let answered: Array<{ id: string; result: GuardedResult }>;
          try {
            // CONCURRENTLY: the model issued them together, and serializing would
            // queue N approval waits behind each other. One call, one guard
            // verdict, one answer — the box handed each ask out exactly once.
            answered = await Promise.all(asks.map(async (ask) => ({
              id: ask.id,
              result: await turnRequest.callTool(ask.name, (ask.args ?? {}) as Record<string, unknown>),
            })));
          } finally {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = undefined;
            entry.leased = true;
          }
          for (const { id, result } of answered) {
            await request(`/turn/${turnId}/answer`, { id, result });
          }
          continue;
        }
        if (polled["done"] === true) return;
      }
    },

    async release() {
      entry.leased = false;
      armIdle(options.threadId, entry, idleTtlMs);
      // The machine is warm, so there is usually nothing to carry — a `resume`
      // only becomes real once a sweep has taken it, and the in-process `swept`
      // map is what the NEXT turn in THIS process reads. Handing it up too is
      // what lets a restart, or another replica, wake the same session.
      const resume = entry.resume ?? swept.get(options.threadId);
      return resume === undefined ? undefined : { resume };
    },
  };
}

/** Test + shutdown seam: drop every pooled machine. */
export async function disposeSessionMachines(): Promise<void> {
  const entries = [...pool.entries()];
  pool.clear();
  swept.clear();
  for (const [, entry] of entries) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    await entry.machine.destroy().catch(() => undefined);
  }
}
