/**
 * The machine a `claudeCode()` turn runs on — the port both drivers implement.
 *
 * The whole difference between `machine: "local"` and the sandbox path is behind
 * this interface: where the workspace copy lands, and how the SDK loop is
 * reached. Everything above it (checkout, the diff sync-back, the guarded
 * projection, `turn.state`) is shared, which is what stops the opt-in from being
 * a second implementation of the same harness.
 */
import type { ClaudeTurnEvent, ClaudeTurnTool, GuardedCall } from "@vendoai/apps/claude-turn";
import type { CheckoutFile, SyncFile } from "../materialize.js";

export interface TurnRequest {
  prompt: string;
  systemPrompt?: string;
  tools: readonly ClaudeTurnTool[];
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** The native session to continue (`turn.state`). */
  resume?: string;
  /** Resume only up to this assistant uuid — the SDK's native prefix rewind. */
  resumeAt?: string;
  callTool: GuardedCall;
  emit: (event: ClaudeTurnEvent) => void;
  signal?: AbortSignal;
}

export interface TurnMachine {
  /**
   * Does this machine's disk still hold the native session `turn.state` names?
   *
   * False for a machine that was just created — a first turn, or a woken box that
   * had to be abandoned. The harness must then re-seed from OUR transcript
   * instead of asking the SDK to resume a session no disk holds, which fails the
   * turn outright.
   */
  readonly carriesSession: boolean;
  /** Land the checkout on this machine's disk. `/host` lands read-only. */
  materialize(files: readonly CheckoutFile[]): Promise<void>;
  /**
   * Read the workspace back, in WORKSPACE paths. `paths` narrows the read to the
   * mid-turn hot set; omitted, it is the whole writable tree — which is what
   * makes deletions visible at turn end.
   *
   * A `paths` entry may name a `*` segment (`/user/apps/&#42;/plan.vendo`), matching
   * exactly one segment. That is the only way a file the turn INVENTED — a plan
   * for an app whose id did not exist when the turn started — reaches the hot
   * sync, and it is matched machine-side so the wire carries the hot files only.
   */
  collect(paths?: readonly string[]): Promise<SyncFile[]>;
  run(request: TurnRequest): Promise<void>;
  /**
   * The turn is over. Local disposes; the sandbox pool keeps the machine warm
   * for the next turn and returns the state to carry in `turn.state`.
   */
  release(): Promise<{ resume?: { ref: string; token: string } } | void>;
}
