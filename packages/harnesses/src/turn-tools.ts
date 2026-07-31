import type {
  ApprovalId,
  ConnectRequired,
  Guard,
  Json,
  RiskLabel,
  RunContext,
  ToolCall,
  ToolListing,
  ToolOutcome,
  ToolRegistry,
  ToolResult,
  TurnTools,
} from "@vendoai/core";

/**
 * Build contract §1.4 — the frozen bound on an interactive approval wait. A
 * closed tab must not hold a turn open forever, and no sandbox lease is held
 * while waiting.
 */
export const APPROVAL_WAIT_MS = 90_000;

/**
 * What the runtime writes to the transcript and the screen on the harness's
 * behalf (build contract §1.5: "Tool calls are mirrored by the runtime, never
 * yielded"). One seam, so the wire code stays in wire.ts and the guard/approval
 * logic stays here.
 */
export type MirrorEvent =
  | { kind: "call"; toolCallId: string; name: string; args: Json }
  | { kind: "result"; toolCallId: string; name: string; result: ToolResult }
  | { kind: "approval"; toolCallId: string; approvalId: ApprovalId; risk: RiskLabel }
  | { kind: "connect"; toolCallId: string; connect: ConnectRequired };

export interface TurnToolsOptions {
  /** The GUARD-BOUND registry (`VendoGuard.bind(tools)`) — the one choke point.
   *  Wrapping it again here would double-charge the guard's breakers. */
  registry: ToolRegistry;
  guard: Guard;
  ctx: RunContext;
  /** §1.4: did the caller prove presence? Decides wait-or-fail, nothing else. */
  interactive: boolean;
  mirror: (event: MirrorEvent) => void;
  /** Test seam only — production always uses {@link APPROVAL_WAIT_MS}. */
  approvalWaitMs?: number;
}

/** A tool call the harness asked for, in the id space the wire already uses. */
let counter = 0;
const mintToolCallId = (): string => `hcall_${(counter += 1)}_${globalThis.crypto.randomUUID()}`;

/**
 * §1.4's race: the approvalId only exists once `execute()` has returned, but the
 * user's tap can land in that same tick. Subscribing to every decision for the
 * whole turn and buffering the ones nobody is waiting for yet is what makes the
 * wait reliable; a late subscribe would hang until the timeout.
 */
export interface ApprovalWaiter {
  /** Resolves true/false with the decision, or undefined if the bound expired. */
  wait(approvalId: ApprovalId, timeoutMs: number): Promise<boolean | undefined>;
  dispose(): void;
}

export function createApprovalWaiter(guard: Guard): ApprovalWaiter {
  const decided = new Map<ApprovalId, boolean>();
  const waiting = new Map<ApprovalId, (approved: boolean) => void>();
  const unsubscribe = guard.onApprovalDecision((id, approved) => {
    decided.set(id, approved);
    const resolve = waiting.get(id);
    if (resolve !== undefined) {
      waiting.delete(id);
      resolve(approved);
    }
  });
  return {
    async wait(approvalId, timeoutMs) {
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

export function createTurnTools(options: TurnToolsOptions): TurnTools & { dispose(): void } {
  const waiter = createApprovalWaiter(options.guard);
  const approvalWaitMs = options.approvalWaitMs ?? APPROVAL_WAIT_MS;

  const riskOf = async (name: string): Promise<RiskLabel> => {
    try {
      const descriptors = await options.registry.descriptors();
      return descriptors.find((descriptor) => descriptor.name === name)?.risk ?? "write";
    } catch {
      // An unreadable catalog must not decide the call; assume the middle risk
      // for the CARD only — the guard already made the real decision.
      return "write";
    }
  };

  const execute = async (call: ToolCall): Promise<ToolOutcome> => {
    try {
      return await options.registry.execute(call, options.ctx);
    } catch {
      return { status: "error", error: { code: "execution", message: "The action could not be completed." } };
    }
  };

  return {
    async list(): Promise<ToolListing[]> {
      const descriptors = await options.registry.descriptors();
      return descriptors.map((descriptor) => ({
        name: descriptor.name,
        // `title` is presentation-only and optional; absent it the surfaces that
        // show a tool to a person fall back to the name (core tools.ts).
        title: descriptor.title ?? descriptor.name,
        description: descriptor.description,
        risk: descriptor.risk,
      }));
    },

    async call(name, args, opts): Promise<ToolResult> {
      const toolCallId = mintToolCallId();
      options.mirror({ kind: "call", toolCallId, name, args });
      const finish = (result: ToolResult): ToolResult => {
        options.mirror({ kind: "result", toolCallId, name, result });
        return result;
      };

      try {
        // `idempotencyKey` rides the call so the guard's effect ledger (contract
        // §7, written inside the guard's execute path) can key on the harness's
        // own notion of "the same action". `toolCallSchema` is passthrough, so
        // it survives validation; no wave-1 consumer reads it yet.
        const call: ToolCall = {
          id: toolCallId,
          tool: name,
          args,
          ...(opts?.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
        };

        const outcome = await execute(call);
        if (outcome.status !== "pending-approval") {
          if (outcome.status === "connect-required") {
            options.mirror({ kind: "connect", toolCallId, connect: outcome.connect });
          }
          return finish(toToolResult(outcome));
        }

        // §1.4. The card goes up either way: interactive callers tap it here,
        // and an unattended run leaves it standing as the failure card's grant.
        const { approvalId } = outcome;
        options.mirror({ kind: "approval", toolCallId, approvalId, risk: await riskOf(name) });

        if (!options.interactive) {
          return finish({
            status: "denied",
            reason: "This needs your approval, and nobody is here to give it.",
            needs: { kind: "approval", approvalId },
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
        if (!approved) {
          return finish({ status: "denied", reason: "You turned this down." });
        }
        // The tap happened, so the call continues: re-entering the guard-bound
        // registry is what makes the grant real. No replay, no cached effect.
        const settled = await execute({ ...call, id: toolCallId });
        if (settled.status === "pending-approval") {
          // The guard asked twice for one tap; refusing to loop is the honest
          // answer (a second card for the same call would be a trap).
          return finish({
            status: "denied",
            reason: "This still needs approval.",
            needs: { kind: "approval", approvalId: settled.approvalId },
          });
        }
        return finish(toToolResult(settled));
      } catch {
        // §1.1: call() never throws. A bug anywhere above becomes a result.
        return finish(executionError());
      }
    },

    dispose: waiter.dispose,
  };
}
