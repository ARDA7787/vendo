import type {
  ApprovalId,
  Guard,
  Json,
  RunContext,
  ToolDescriptor,
  ToolListing,
  ToolOutcome,
  ToolRegistry,
  ToolResult,
  TurnTools,
} from "@vendoai/core";
import { guardedCall, previewApproval, type ToolBridgeOptions } from "@vendoai/agent/internal";

/**
 * Build contract §1.4 — the frozen bound on an interactive approval wait. A
 * closed tab must not hold a turn open forever, and no sandbox lease is held
 * while waiting.
 */
export const APPROVAL_WAIT_MS = 90_000;

/**
 * What the runtime writes to the transcript and the screen on the harness's
 * behalf (build contract §1.5: "Tool calls are mirrored by the runtime, never
 * yielded"). This is the ai-SDK tool-part mirror ONLY — the `data-vendo-*` parts
 * (view, approval, connect, build-failed, citations) are written by the SHIPPED
 * bridge inside `guardedCall`/`previewApproval`, so a harness produces the
 * identical wire a `createAgent` turn does.
 */
export type MirrorEvent =
  | { kind: "call"; toolCallId: string; name: string; args: Json }
  | { kind: "result"; toolCallId: string; name: string; result: ToolResult };

export interface TurnToolsOptions {
  /** The GUARD-BOUND registry (`VendoGuard.bind(tools)`) — the one choke point.
   *  Wrapping it again here would double-charge the guard's breakers. */
  registry: ToolRegistry;
  guard: Guard;
  ctx: RunContext;
  /** §1.4: did the caller prove presence? Decides wait-or-fail, nothing else. */
  interactive: boolean;
  mirror: (event: MirrorEvent) => void;
  /** The rest of the shipped bridge's rails: the writer the `data-vendo-*` parts
   *  go to, `toolOutputCap`, `preflight`, the per-turn `connectCards` dedupe set,
   *  and the capability-miss `onCall` hook. */
  bridge?: Omit<ToolBridgeOptions, "registry" | "ctx" | "guard">;
  /** Test seam only — production always uses {@link APPROVAL_WAIT_MS}. */
  approvalWaitMs?: number;
}

let counter = 0;
const mintToolCallId = (): string => `hcall_${(counter += 1)}_${globalThis.crypto.randomUUID()}`;

/**
 * §1.4's race: the approvalId only exists once the guard has been consulted, but
 * the user's tap can land in that same tick. Subscribing to every decision for
 * the whole turn and buffering the ones nobody is waiting for yet is what makes
 * the wait reliable; a late subscribe would hang until the timeout.
 */
export interface ApprovalWaiter {
  /** Resolves true/false with the decision, or undefined if the bound expired. */
  wait(approvalId: ApprovalId, timeoutMs: number): Promise<boolean | undefined>;
  /**
   * Note an approval this turn raised, WHICHEVER path minted it — the preview, or
   * the real dispatching check after the preview said run (a breaker or presence
   * boundary). Recording only the ones we wait on would leak the rest forever.
   *
   * `standing: true` marks the `interactive: false` card, which is MEANT to
   * survive the turn so "Grant & re-run" can collect it.
   */
  raise(approvalId: ApprovalId, options?: { standing?: boolean }): void;
  /** Raised, undecided, and not standing — the runtime abandons these at turn
   *  end, so a live-but-dead card cannot accrete in the pending queue. */
  unanswered(): ApprovalId[];
  dispose(): void;
}

export function createApprovalWaiter(guard: Guard): ApprovalWaiter {
  const decided = new Map<ApprovalId, boolean>();
  const waiting = new Map<ApprovalId, (approved: boolean) => void>();
  const raised = new Set<ApprovalId>();
  const standing = new Set<ApprovalId>();
  const unsubscribe = guard.onApprovalDecision((id, approved) => {
    decided.set(id, approved);
    const resolve = waiting.get(id);
    if (resolve !== undefined) {
      waiting.delete(id);
      resolve(approved);
    }
  });
  return {
    raise(approvalId, options) {
      raised.add(approvalId);
      if (options?.standing === true) standing.add(approvalId);
    },
    async wait(approvalId, timeoutMs) {
      raised.add(approvalId);
      const already = decided.get(approvalId);
      if (already !== undefined) return already;
      return new Promise<boolean | undefined>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(approvalId);
          resolve(undefined);
        }, timeoutMs);
        waiting.set(approvalId, (approved) => {
          clearTimeout(timer);
          resolve(approved);
        });
      });
    },
    unanswered: () => [...raised].filter((id) => !decided.has(id) && !standing.has(id)),
    dispose: unsubscribe,
  };
}

/** The one generic failure a harness ever sees from a broken seam. Raw
 *  provider/registry internals never travel (consumer voice law, §3). */
const executionError = (): ToolResult => ({
  status: "error",
  error: { code: "execution", message: "The action could not be completed." },
});

/**
 * §1.1 — the runtime's job, not the harness author's: five core statuses in,
 * three out. `pending-approval` is handled by the caller below (interactive
 * callers block first, §1.4), so it is the one status this mapping refuses.
 */
function toToolResult(outcome: Exclude<ToolOutcome, { status: "pending-approval" }>): ToolResult {
  switch (outcome.status) {
    case "ok":
      return { status: "ok", output: outcome.output };
    case "error":
      return { status: "error", error: outcome.error };
    case "blocked":
      return { status: "denied", reason: outcome.reason };
    case "connect-required":
      return {
        status: "denied",
        reason: outcome.connect.message,
        needs: { kind: "connect", toolkit: outcome.connect.toolkit },
      };
  }
}

export interface RuntimeTurnTools extends TurnTools {
  /** §1.4 + the orphaned-approval fix: ids this turn raised and nobody answered. */
  unansweredApprovals(): ApprovalId[];
  dispose(): void;
}

export function createTurnTools(options: TurnToolsOptions): RuntimeTurnTools {
  const waiter = createApprovalWaiter(options.guard);
  const approvalWaitMs = options.approvalWaitMs ?? APPROVAL_WAIT_MS;
  const bridge: ToolBridgeOptions = {
    ...options.bridge,
    registry: options.registry,
    ctx: options.ctx,
    guard: options.guard,
  };

  const descriptorFor = async (name: string): Promise<ToolDescriptor | undefined> => {
    try {
      return (await options.registry.descriptors()).find((descriptor) => descriptor.name === name);
    } catch {
      return undefined;
    }
  };

  return {
    async list(): Promise<ToolListing[]> {
      // `ctx` is load-bearing, not decoration: the guard-bound registry answers
      // `descriptors(ctx)` with `projectableForRun(all, ctx)`, which is where THE
      // LAW (design §12) withholds destructive and external tools from an
      // unattended run. Asking without it listed EVERY tool to an automation,
      // which the harness then offered its model — and the refusal only arrived
      // at call time. "Not projected into an automation run at all" has to mean
      // not projected.
      const descriptors = await options.registry.descriptors(options.ctx);
      return descriptors.map((descriptor) => ({
        name: descriptor.name,
        // `title` is presentation-only and optional; absent it the surfaces that
        // show a tool to a person fall back to the name (core tools.ts).
        title: descriptor.title ?? descriptor.name,
        description: descriptor.description,
        risk: descriptor.risk,
        // Contract §1.1 amendment 2026-07-30: an in-process harness must hand its
        // model real argument schemas, and JSON Schema is the interchange.
        // Without this a third-party harness can see a tool and still not call
        // it — only `vendo()` worked, because composition hands IT the
        // descriptor catalog by closure.
        ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
      }));
    },

    async call(name, args): Promise<ToolResult> {
      const toolCallId = mintToolCallId();
      options.mirror({ kind: "call", toolCallId, name, args });
      const finish = (result: ToolResult): ToolResult => {
        options.mirror({ kind: "result", toolCallId, name, result });
        return result;
      };

      try {
        const descriptor = await descriptorFor(name);
        if (descriptor === undefined) {
          return finish({
            status: "error",
            error: { code: "not-found", message: `Unknown tool: ${name}` },
          });
        }

        // §1.4: PREVIEW first, exactly as the ai-SDK path's needsApproval hook
        // does. A preview never spends the write-budget/call-rate breakers and
        // never runs the judge a second time, so an approved call is executed
        // ONCE below rather than executed-then-re-executed.
        let approvalId: ApprovalId | undefined;
        const ask = await previewApproval(descriptor, bridge, (id) => {
          approvalId = id;
        })(args, { toolCallId });

        if (ask) {
          if (approvalId !== undefined) {
            waiter.raise(approvalId, { standing: !options.interactive });
          }
          if (!options.interactive) {
            // Nobody is here to tap, so the run fails loudly and the card stands
            // as the grant "Grant & re-run" will collect.
            return finish({
              status: "denied",
              reason: "This needs your approval, and nobody is here to give it.",
              ...(approvalId === undefined
                ? {}
                : { needs: { kind: "approval" as const, approvalId } }),
            });
          }
          if (approvalId === undefined) {
            // The guard failed closed and minted no id to wait on.
            return finish({
              status: "denied",
              reason: "This needs approval, and the check could not run.",
            });
          }
          const approved = await waiter.wait(approvalId, approvalWaitMs);
          if (approved === undefined) {
            return finish({
              status: "denied",
              reason: "The approval timed out.",
              needs: { kind: "approval", approvalId },
            });
          }
          if (!approved) return finish({ status: "denied", reason: "You turned this down." });
        }

        // The SHIPPED guarded-call path: the guard, the audit row, the view
        // channel (a `vendo_apps_*` tree plus the VENDO_VIEW_STREAM partials),
        // the connect card, the build-failed banner, the citations part and
        // `toolOutputCap` all come from here — never a second implementation.
        const outcome = await guardedCall(descriptor, bridge)(args, { toolCallId });
        if (outcome.status === "pending-approval") {
          // The preview said run and the REAL check asked — a breaker or presence
          // boundary. Nobody is waiting on this one, so it must still be swept.
          waiter.raise(outcome.approvalId, { standing: !options.interactive });
          // The guard asked twice for one tap; refusing to loop is the honest
          // answer (a second card for the same call would be a trap).
          return finish({
            status: "denied",
            reason: "This still needs approval.",
            needs: { kind: "approval", approvalId: outcome.approvalId },
          });
        }
        return finish(toToolResult(outcome));
      } catch {
        // §1.1: call() never throws. A bug anywhere above becomes a result.
        return finish(executionError());
      }
    },

    unansweredApprovals: waiter.unanswered,
    dispose: waiter.dispose,
  };
}
