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
  token: string;
  /** Set while the machine is doing work nobody may reclaim under. */
  leased: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Where the machine went when the sweep took it. */
  resumeRef?: string;
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
const swept = new Map<string, string>();

const mintToken = (): string => `bxt_${globalThis.crypto.randomUUID()}`;

async function control(
  entry: PoolEntry,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const answer = await entry.machine.request({
    method,
    path,
    port: CONTROL_PORT,
    headers: {
      "content-type": "application/json",
      // The box refuses any /turn route without it: the ONE thing the machine
      // holds besides a workspace copy and the inference key.
      "x-vendo-box-token": entry.token,
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
      if (entry.leased) return;
      pool.delete(threadId);
      try {
        const ref = await entry.machine.snapshot();
        entry.resumeRef = ref;
        swept.set(threadId, ref);
      } catch {
        // No snapshot means the next turn starts fresh and re-seeds from our
        // transcript — disposable by contract.
        swept.delete(threadId);
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
  /** The snapshot a previous idle sweep left behind (`turn.state`). */
  resumeRef?: string;
  /** Provider template; defaults to `VENDO_BOX_TEMPLATE`. */
  template?: string;
  /** Test seam; production uses {@link MACHINE_IDLE_TTL_MS}. */
  idleTtlMs?: number;
}

export async function boxMachine(options: BoxMachineOptions): Promise<TurnMachine> {
  const idleTtlMs = options.idleTtlMs ?? MACHINE_IDLE_TTL_MS;
  const existing = pool.get(options.threadId);
  let entry: PoolEntry;
  if (existing !== undefined) {
    if (existing.timer !== undefined) clearTimeout(existing.timer);
    entry = existing;
  } else {
    const idleRef = swept.get(options.threadId);
    const token = mintToken();
    // Deliberately NOT setting CLAUDE_CONFIG_DIR: the SDK's default is under
    // $HOME, and `/workspace` is EMPTIED and re-materialized at the start of
    // every turn — parking the native session there would have deleted it on
    // turn 2, which is the one thing the session machine exists to prevent. The
    // snapshot carries the whole disk, so $HOME is where it belongs.
    const env = {
      ...options.env,
      VENDO_BOX_TOKEN: token,
      VENDO_WORKSPACE_ROOT: "/workspace",
    };
    let machine: SandboxMachineLike | undefined;
    // The sweep's own ref first: it is newer than anything a caller could carry.
    const resumeFrom = idleRef ?? options.resumeRef;
    if (resumeFrom !== undefined) {
      try {
        machine = await options.sandbox.resume(resumeFrom);
        swept.delete(options.threadId);
      } catch {
        // A snapshot the provider dropped is a re-seed, not a failure.
        machine = undefined;
        swept.delete(options.threadId);
      }
    }
    if (machine === undefined) {
      const template = options.template
        ?? globalThis.process?.env?.["VENDO_BOX_TEMPLATE"];
      machine = await options.sandbox.create({
        ...(template === undefined ? {} : { template }),
        env,
      });
    }
    entry = { machine, token, leased: true };
    pool.set(options.threadId, entry);
    // The credential handoff, and the only one. The provider does NOT hand
    // create-time envs to a template's start command, and a resumed machine
    // boots with the snapshot's env rather than ours — so the inference key and
    // the token both arrive here, with the turn that needs them.
    const { status } = await control(entry, "POST", "/turn/hello", { token, env: options.env });
    if (status !== 200) {
      pool.delete(options.threadId);
      await machine.destroy().catch(() => undefined);
      throw new VendoError("sandbox-unavailable", `the workspace machine refused the turn handshake (${status})`);
    }
  }
  entry.leased = true;

  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const { status, json } = await control(entry, "POST", path, body);
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

        const ask = polled["ask"] as { id?: unknown; name?: unknown; args?: unknown } | undefined;
        if (ask !== undefined && typeof ask.id === "string" && typeof ask.name === "string") {
          // §1.4, made real rather than declared: a guarded call may block up to
          // APPROVAL_WAIT_MS for a human tap, and no machine lease may outlive
          // that. So the lease is DROPPED and the idle sweep ARMED for the whole
          // window — a wait that outlives the machine's idle budget loses the
          // machine, and losing it mid-turn is the case the store already
          // survives (nothing syncs, the next turn recovers on a fresh one).
          entry.leased = false;
          armIdle(options.threadId, entry, idleTtlMs);
          let result;
          try {
            result = await turnRequest.callTool(ask.name, (ask.args ?? {}) as Record<string, unknown>);
          } finally {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = undefined;
            entry.leased = true;
          }
          await request(`/turn/${turnId}/answer`, { id: ask.id, result });
          continue;
        }
        if (polled["done"] === true) return;
      }
    },

    async release() {
      entry.leased = false;
      armIdle(options.threadId, entry, idleTtlMs);
      // The machine is warm, so there is usually nothing to carry — `resumeRef`
      // only becomes real once a sweep has taken it, and the in-process `swept`
      // map is what the NEXT turn actually reads. Handing it up too lets a
      // different replica pick the session up once one exists.
      const ref = entry.resumeRef ?? swept.get(options.threadId);
      return ref === undefined ? undefined : { resumeRef: ref };
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
