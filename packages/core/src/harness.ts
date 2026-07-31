/**
 * The harness contract — build contract 2026-07-30 §1, copied verbatim.
 *
 * Types only, so every block may speak them: `defineHarness` and the runtime
 * that builds a `Turn` live in `@vendoai/harnesses` (build contract §2). The
 * dividing line these shapes draw: we own state, tools, checks, guard, and
 * skills; the harness owns thinking — and orchestration is thinking. A harness
 * receives a `Turn` and yields a closed event vocabulary; it never persists,
 * never touches the wire, and never decides whether a call is allowed.
 *
 * §1.5's `HarnessEvent` list is CLOSED for v1 — adding a member is a breaking
 * change for every host renderer.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { UIMessage } from "ai";
import type { Json } from "./ids.js";
import type { ResolvedModels } from "./models.js";
import type { WorkspaceFs } from "./workspace.js";

/** Build contract §1 */
export interface Harness<Options = unknown> {
  readonly name: string;
  /** Declares the per-turn-overridable knobs. */
  readonly optionsSchema?: StandardSchemaV1;
  /** Boot-time composition check — never a runtime surprise. */
  readonly requires?: { sandbox?: boolean };
  run(turn: Turn<Options>): AsyncGenerator<HarnessEvent, void, void>;
}

/** Build contract §1 */
export interface Turn<Options = unknown> {
  /** Canonical transcript, oldest → newest. Ours; read-only. */
  readonly messages: readonly UIMessage[];
  readonly tools: TurnTools;
  readonly skills: TurnSkills;
  /** §3; the harness's file hands. */
  readonly workspace: WorkspaceFs;
  /** §4 */
  readonly models: ResolvedModels;
  /** §1.3 */
  readonly state: TurnState;
  /** Parsed by optionsSchema, incl. per-turn overrides. */
  readonly options: Options;
  readonly signal: AbortSignal;
  /** Present iff the caller proved presence (a click/message/submit). */
  readonly interactive: boolean;
}

/** Build contract §1.1 */
export interface TurnTools {
  /** Never throws. Guarded, audited, and mirrored before it resolves. */
  call(name: string, args: Json): Promise<ToolResult>;
  /** Currently-equipped tools (post-curation). */
  list(): Promise<ToolListing[]>;
}

/** Build contract §1.1 — three statuses is the whole surface a harness sees. */
export type ToolResult =
  | { status: "ok"; output: Json }
  /** Guard said no / needs a human. */
  | { status: "denied"; reason: string; needs?: DeniedNeeds }
  | { status: "error"; error: { code: string; message: string } };

/** Build contract §1.1 */
export type DeniedNeeds =
  /** A card is waiting for the user. */
  | { kind: "approval"; approvalId: string }
  /** An account must be connected. */
  | { kind: "connect"; toolkit: string }
  /** §12 law: never available off-interaction. */
  | { kind: "unattended-destructive" };

/** Build contract §1.1 */
export interface ToolListing {
  name: string;
  title: string;
  description: string;
  risk: "read" | "write" | "destructive";
}

/** Build contract §1.2 */
export interface TurnSkills {
  /** ~30 tokens each; always cheap. */
  list(): Promise<SkillListing[]>;
  /** Full SKILL.md body, on demand. */
  load(name: string): Promise<string>;
}

/** Build contract §1.2 */
export interface SkillListing {
  name: string;
  description: string;
}

/**
 * Build contract §1.3 — the harness's own state, opaque to us. Cleared by the
 * runtime on arbitrary history edits or a harness swap; a prefix truncation
 * uses the harness's native rewind instead (adapter's business).
 */
export interface TurnState {
  /** Opaque to us. */
  get(): string | undefined;
  /** Persisted at turn end. */
  set(value: string): void;
  clear(): void;
}

/**
 * Build contract §1.5 — the CLOSED yield vocabulary. Routing (frozen):
 * `text` → screen + transcript · `status` → screen only · `error` → screen +
 * transcript + audit · `usage` → audit/metering only. Tool calls are mirrored
 * by the runtime, never yielded; harnesses never yield view events.
 */
export type HarnessEvent =
  | { type: "text"; delta: string }
  /** Consumer-voice; ephemeral, screen-only. */
  | { type: "status"; label: string }
  /** Consumer-voice; no internals. */
  | { type: "error"; message: string; code?: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      model?: string;
    };
