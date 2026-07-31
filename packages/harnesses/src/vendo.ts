/**
 * `vendo()` — the default harness: today's `@vendoai/agent` loop re-expressed on
 * the frozen contract. Same behaviour, in-process, key-free.
 *
 * What changed in the lift, and only this:
 * - tools execute through `turn.tools.call()`, so the guard, the audit row and
 *   the transcript mirror are no longer this file's business (they cannot be
 *   forgotten);
 * - approvals are §1.4's wait-or-fail INSIDE `call()`, so there is no
 *   `needsApproval` hook and no second consent path;
 * - output is the closed `HarnessEvent` vocabulary instead of wire chunks, so
 *   this file contains no persistence and no wire code;
 * - it hires its own subagents for big jobs. Weight and staffing are the
 *   harness's business — that is the dividing line, and orchestration is thinking.
 */
import { z } from "zod";
import type { Harness, Json, ToolDescriptor, Turn } from "@vendoai/core";
import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import { convertToModelMessages } from "ai";
import { defineHarness } from "./define.js";

/** Unchanged from today's loop (`DEFAULT_MAX_STEPS`): hosts raise or lower it. */
const DEFAULT_MAX_STEPS = 20;

/** How many messages a hired subagent may exchange before it must report back.
 *  Bounded so a runaway helper costs a receipt, not a turn. */
const SUBAGENT_MAX_STEPS = 12;

/** Anthropic prompt-caching breakpoint. `providerOptions.anthropic` is ignored by
 *  every other provider, so marking breakpoints degrades to a no-op. */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

const HIRE_SUBAGENT = "hire_subagent";

/**
 * The per-turn knobs. `model` is here because a host may forward a model picker
 * to its end users (architecture §3, "Options are declared, then overridable per
 * turn"); everything else defaults.
 */
const optionsSchema = z.object({
  /** Overrides the `default` seat for this turn only. */
  model: z.unknown().optional(),
  maxSteps: z.number().int().positive().optional(),
});

export interface VendoHarnessOptions {
  model?: LanguageModel;
  maxSteps?: number;
}

export interface VendoHarnessDeps {
  /**
   * The pre-assembled system prompt. A `Turn` deliberately carries no
   * RunContext — harnesses are permission-blind — so the guard-directions and
   * venue-gated half of the prompt is assembled by composition
   * (`assembleSystemPrompt` in @vendoai/agent) and handed in here.
   */
  system?: string | (() => string | undefined | Promise<string | undefined>);
  /**
   * Argument schemas for the equipped tools.
   *
   * SEAM NOTE: `ToolListing` (contract §1.1) carries name/title/description/risk
   * but no `inputSchema`, and an in-process harness must give its model real
   * argument schemas or it degrades badly. Rather than diverge from the frozen
   * shape, the descriptor catalog — which is OURS, not thinking — arrives by
   * factory closure. Execution still goes through `turn.tools.call()` only, so
   * there is no unguarded path. Unset, the model gets names and descriptions and
   * a permissive object schema.
   */
  descriptors?: () => Promise<ToolDescriptor[]>;
  maxSteps?: number;
}

/** A tool the model may call whose execution is `turn.tools.call` and nothing else. */
function equippedTools(turn: Turn<unknown>, descriptors: ToolDescriptor[]): ToolSet {
  const tools: ToolSet = {};
  for (const descriptor of descriptors) {
    tools[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema as Parameters<typeof jsonSchema>[0]),
      // The whole safety story in one line: the guard, the audit row, the
      // transcript mirror and §1.4's approval block all live behind `call()`.
      execute: async (input: unknown) => turn.tools.call(descriptor.name, input as Json),
    });
  }
  return tools;
}

/**
 * A hired subagent: a fresh, blinkered loop with the same hands and the same
 * guard, whose OWN words never leave this function. The resident keeps only the
 * receipt — which is its private context, not a wire artifact, so the
 * one-assistant law holds without a transcript-only channel (§1.5's routing table
 * has none, deliberately).
 */
async function runSubagent(
  turn: Turn<unknown>,
  model: LanguageModel,
  input: { instructions: string; skill?: string },
  tools: ToolSet,
): Promise<string> {
  let brief = input.instructions;
  if (input.skill !== undefined) {
    // The full SKILL.md body is the job description; loading it is the point of
    // hiring rather than inlining.
    const body = await turn.skills.load(input.skill);
    brief = `${body}\n\n---\n\n${input.instructions}`;
  }
  const result = streamText({
    model,
    system:
      "You are a specialist hired for one job. Do it with the tools you have, then report back in "
      + "at most three sentences. Your reply is read by another agent, not by a person.",
    prompt: brief,
    // No hiring tool: depth is bounded at one, so a helper cannot spawn a tree.
    tools,
    stopWhen: [stepCountIs(SUBAGENT_MAX_STEPS)],
    abortSignal: turn.signal,
  });
  const text = await result.text;
  return text.trim() || "The specialist finished without a summary.";
}

export function vendo(deps: VendoHarnessDeps = {}): Harness<VendoHarnessOptions> {
  return defineHarness<VendoHarnessOptions>({
    name: "vendo",
    optionsSchema,
    // Machine-less by design: in-process bash over the workspace is enough
    // (architecture §4, "Hands vary").
    async *run(turn) {
      // A caller that hung up before the turn started gets no model call at all.
      if (turn.signal.aborted) return;

      const model = turn.options?.model ?? turn.models.default;
      const maxSteps = turn.options?.maxSteps ?? deps.maxSteps ?? DEFAULT_MAX_STEPS;
      const system = typeof deps.system === "function" ? await deps.system() : deps.system;

      const descriptors = (await deps.descriptors?.()) ?? [];
      const hostTools = equippedTools(turn, descriptors);
      const residentTools: ToolSet = {
        ...hostTools,
        [HIRE_SUBAGENT]: tool({
          description:
            "Hire a specialist for one big job (building or editing an app, a long research pass). "
            + "Name a skill to give it the full instructions. It reports back a short summary.",
          inputSchema: z.object({
            instructions: z.string().describe("What the specialist should accomplish."),
            skill: z.string().optional().describe("A skill name from your skill list."),
          }),
          execute: async (input) => {
            try {
              // The specialist gets the same hands, minus the hiring tool.
              return { summary: await runSubagent(turn, model, input, hostTools) };
            } catch (error) {
              // A failed hire is one tool result the resident can react to — it
              // is never the turn's death.
              console.error("[vendo] harness: subagent failed", {
                error: error instanceof Error ? error.message : String(error),
              });
              return { error: "The specialist could not be reached for that job." };
            }
          },
        }),
      };

      const modelMessages = await residentHistory(turn.messages, system);

      let capped = false;
      try {
        const result = streamText({
          model,
          messages: modelMessages,
          tools: residentTools,
          stopWhen: [stepCountIs(maxSteps)],
          abortSignal: turn.signal,
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              yield { type: "text", delta: part.text };
              break;
            case "error":
              // The model/provider error itself never travels (it can carry
              // request internals); the operator's terminal gets the truth.
              console.error("[vendo] harness: model stream error", part.error);
              yield { type: "error", message: "I ran into a problem answering that.", code: "model" };
              break;
            case "finish": {
              // `model` is left unset: the contract's field is optional, and the
              // resolved model id is not on this part — composition, which chose
              // the seat, is the honest place to attribute it.
              const { inputTokens, outputTokens, inputTokenDetails } = part.totalUsage;
              yield {
                type: "usage",
                inputTokens: inputTokens ?? 0,
                outputTokens: outputTokens ?? 0,
                ...(inputTokenDetails.cacheReadTokens === undefined
                  ? {}
                  : { cacheReadTokens: inputTokenDetails.cacheReadTokens }),
                ...(inputTokenDetails.cacheWriteTokens === undefined
                  ? {}
                  : { cacheWriteTokens: inputTokenDetails.cacheWriteTokens }),
              };
              break;
            }
            default:
              // Tool chunks are consumed here and dropped: the RUNTIME mirrors
              // tool calls (§1.5), so echoing them would double every call.
              break;
          }
        }

        const [finishReason, steps] = await Promise.all([result.finishReason, result.steps]);
        capped = finishReason === "tool-calls" && steps.length >= maxSteps;
      } catch (error) {
        console.error("[vendo] harness: turn failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        yield { type: "error", message: "I ran into a problem answering that.", code: "model" };
        return;
      }

      if (capped) {
        // Exhausting the cap is VISIBLE (today's `data-vendo-step-limit`
        // banner). `HarnessEvent` is closed and has no member for it, so it goes
        // out in the assistant's own voice — screen AND transcript, which is what
        // the banner did.
        yield {
          type: "text",
          delta:
            `\n\nI stopped after reaching the ${maxSteps}-step limit for one turn. `
            + "Reply to continue.",
        };
      }
    },
  });
}

/**
 * The resident's provider history — unchanged from today's loop: the assembled
 * system prompt and the stable history prefix carry cache breakpoints, so
 * Anthropic re-reads the cached prefix instead of re-billing the whole growing
 * thread each turn.
 */
async function residentHistory(
  messages: readonly UIMessage[],
  system: string | undefined,
): Promise<ModelMessage[]> {
  const converted = (await convertToModelMessages([...messages])).filter(
    (message) => message.content.length > 0,
  );
  if (converted.length >= 2) {
    const prefixEnd = converted[converted.length - 2] as ModelMessage;
    prefixEnd.providerOptions = { ...prefixEnd.providerOptions, ...CACHE_BREAKPOINT };
  }
  return [
    ...(system === undefined || system.length === 0
      ? []
      : [{ role: "system" as const, content: system, providerOptions: CACHE_BREAKPOINT }]),
    ...converted,
  ];
}
