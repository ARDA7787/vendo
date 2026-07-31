import {
  isUnattended,
  type Json,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";

/** Design §4 — questions are a tool, one door, any seat. */
export const ASK_USER_TOOL = "ask_user";

/** One recorded answer, exactly the shape the store's guarded gate takes. */
export interface AskUserRecord {
  threadId: string;
  questionId: string;
  answer: Json;
}

export interface AskUserPorts {
  /** The conversation this turn belongs to, bound by the CALLER.
   *
   *  Deliberately not a tool argument and not read from the model's input: a
   *  caller-chosen thread id is an attempt to write into someone else's
   *  conversation, and the transcript is what the next turn reads, so that would
   *  be agent steering. The model cannot name a thread at all. */
  threadId: string;
  /** Persist the answer. Wired to the store's subject-scoped `recordAnswer`,
   *  which refuses a thread the principal does not own. */
  record(principal: Principal, answer: AskUserRecord): Promise<void>;
  /** Put the question to the person and wait for their reply. Absent means no
   *  surface is wired (an away runner has no card surface). */
  collect?(question: string, choices?: string[]): Promise<Json>;
}

const DESCRIPTOR: ToolDescriptor = {
  name: ASK_USER_TOOL,
  title: "Ask you a question",
  description:
    "Ask the user a question and wait for their answer. Use this when you genuinely cannot proceed "
    + "without something only they know — never to confirm work you can simply do, and never to "
    + "guess out loud. The answer is recorded in the conversation.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1 },
      choices: { type: "array", items: { type: "string" } },
    },
    required: ["question"],
    additionalProperties: false,
  },
  risk: "read",
};

const UNATTENDED_REASON =
  "There is nobody here to answer a question: this run is unattended. "
  + "Finish what you can without asking, or stop and say what you needed.";

/**
 * The `ask_user` door as a one-tool registry, composed alongside the others so
 * the guard, the audit trail, and `find_tools` all see it like any other tool.
 *
 * It is a `read` because asking costs no authority — §12's "reads are silent,
 * always" — so a question never spends a grant or raises a consent card. What it
 * must never be is available with nobody present, which is enforced twice: the
 * descriptor is withheld from an unattended run, and execute refuses one.
 */
export function askUserRegistry(ports: AskUserPorts): ToolRegistry {
  let minted = 0;
  return {
    async descriptors(ctx) {
      // A question with no one to answer it is not a question.
      if (ctx !== undefined && isUnattended(ctx)) return [];
      return [DESCRIPTOR];
    },

    async execute(call, ctx: RunContext) {
      if (isUnattended(ctx)) {
        return { status: "blocked", reason: UNATTENDED_REASON };
      }
      const args = (call.args ?? {}) as { question?: unknown; choices?: unknown };
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (question === "") {
        return {
          status: "error",
          error: { code: "validation", message: "ask_user needs a question to put to the user" },
        };
      }
      if (ports.collect === undefined) {
        return {
          status: "error",
          error: {
            code: "not-implemented",
            message: "No surface is wired to put a question to the user in this composition",
          },
        };
      }
      const choices = Array.isArray(args.choices)
        ? args.choices.filter((choice): choice is string => typeof choice === "string")
        : undefined;
      // The id is SERVER-MINTED, always. It used to accept the model's
      // `questionId` when one was supplied, under a comment claiming the model
      // could not reuse one — which was simply false: a reused id made the store
      // drop the user's real answer while an earlier one stood as theirs. The
      // model has no need to name a row, so it no longer can.
      minted += 1;
      const questionId = `q_${ctx.sessionId}_${Date.now()}_${minted}`;

      try {
        const answer = await ports.collect(question, choices);
        await ports.record(ctx.principal, { threadId: ports.threadId, questionId, answer });
        return { status: "ok", output: { answer } };
      } catch (error) {
        // An answer we could not record is an answer we cannot vouch for. Return
        // the failure, never the collected text — handing it to the model would
        // let it treat unrecorded (possibly refused) input as the user's words.
        return {
          status: "error",
          error: {
            code: "conflict",
            message: `Could not record the user's answer: ${error instanceof Error ? error.message : "unknown error"}`,
          },
        };
      }
    },
  };
}
