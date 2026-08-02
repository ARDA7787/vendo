/**
 * The machine a `claudeCode()` conversation lives on — the port both drivers
 * implement.
 *
 * The whole difference between `machine: "local"` and the sandbox path is behind
 * this interface: where the workspace copy lands, and how the live SDK session is
 * reached. Everything above it (checkout, the diff sync-back, the guarded
 * projection, `turn.state`) is shared, which is what stops the opt-in from being
 * a second implementation of the same harness.
 *
 * cc-native shape: a machine holds ONE session for the whole conversation, so
 * `send()` replaces the old per-turn `run()`. A machine is either FRESH (just
 * created — materialize it and re-seed the thread from our transcript) or WARM
 * (its disk already carries both the files and the native session).
 */
import type { ClaudeTurnEvent, ClaudeTurnTool, GuardedCall } from "@vendoai/apps/claude-turn";
import type { CheckoutFile, SyncFile } from "../materialize.js";

/** What opening a session needs. Fixed for the life of the session, except that
 *  a changed tool listing reopens it (resuming its own id). */
export interface SessionOpen {
  systemPrompt?: string;
  tools: readonly ClaudeTurnTool[];
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** The native session to continue (`turn.state`), on a disk that holds it. */
  resume?: string;
  /** Resume only up to this assistant uuid — the SDK's native prefix rewind. */
  resumeAt?: string;
  /** The local plugin root carrying `skills/<name>/SKILL.md` — our `/host` mount. */
  pluginPath?: string;
  /** Exactly which skills to enable, by name — OURS, never "all" (which would
   *  also enable whatever the machine's own home directory carries). */
  skillNames?: readonly string[];
}

export interface SessionMessage extends SessionOpen {
  prompt: string;
  callTool: GuardedCall;
  emit: (event: ClaudeTurnEvent) => void;
  /** A file the turn wrote, from the SDK's native PostToolUse hook. `undefined`
   *  means a write whose path we cannot know (`Bash`). */
  onFileWritten?: (path: string | undefined) => void;
  signal?: AbortSignal;
}

export interface SessionMachine {
  /**
   * Does this machine's disk already hold the native session AND the workspace?
   *
   * False for a machine that was just created — a first message, or a recovery
   * after the box died. The harness then materializes the checkout and re-seeds
   * the thread from OUR transcript instead of asking the SDK to resume a session
   * no disk holds, which fails the turn outright.
   */
  readonly carriesSession: boolean;
  /**
   * Where the `/host` mount lands on THIS machine's disk — which is also the
   * SDK plugin root, because `hostSkillFiles` already writes
   * `/host/skills/<name>/SKILL.md` and the SDK reads
   * `<pluginPath>/skills/<name>/SKILL.md`. Same layout, so the mount IS the
   * plugin. The machine owns it because the machine owns the disk layout.
   */
  readonly pluginPath: string;
  /** Land the checkout on this machine's disk. `/host` lands read-only. */
  materialize(files: readonly CheckoutFile[]): Promise<void>;
  /**
   * Read the workspace back, in WORKSPACE paths. `paths` narrows the read to the
   * hot set; omitted, it is the whole writable tree — which is what makes
   * deletions visible at turn end.
   *
   * A `paths` entry may name a `*` segment (`/user/apps/&#42;/plan.vendo`), matching
   * exactly one segment. That is the only way a file the turn INVENTED — a plan
   * for an app whose id did not exist when the conversation started — reaches the
   * hot sync, and it is matched machine-side so the wire carries the hot files
   * only.
   */
  collect(paths?: readonly string[]): Promise<SyncFile[]>;
  /** Push one user message into the live session and settle when its turn ends. */
  send(message: SessionMessage): Promise<void>;
  /**
   * The turn is over. Local keeps its session for the next turn; the sandbox path
   * keeps the box warm on an idle timer and destroys it when that expires.
   */
  release(): Promise<void>;
}
