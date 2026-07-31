/**
 * `ask_user` at the composition seam — design §4, "questions as a tool, one
 * door, any seat".
 *
 * Lane D built the tool and the store half. Two things were missing, and both are
 * per-turn while the registry is composed once for the deployment:
 *
 * 1. **The thread the answer belongs in.** Deliberately not a tool argument: a
 *    model-chosen thread id is an attempt to write into someone else's
 *    conversation, and the transcript is what the next turn reads — so that would
 *    be agent steering, not just defacement. It arrives here instead, bound by
 *    the caller.
 * 2. **A surface to put the question on.** Absent one, the tool says so rather
 *    than pretending; see the PARKED note in the repo root for the built-in card,
 *    which needs a wire part, an answer door, and a renderer that does not exist.
 *
 * AsyncLocalStorage carries the per-turn half, the same mechanism the harness
 * runtime uses for hire receipts — a module-level variable would attribute one
 * user's question to another user's thread whenever two turns overlap, which for
 * a subject-scoped write is a security bug, not a mix-up.
 */
import { askUserRegistry, ASK_USER_TOOL, type AskUserPorts } from "@vendoai/agent";
import type { Json, Principal, ToolRegistry } from "@vendoai/core";
import { threadStore, type VendoStore } from "@vendoai/store";
import { AsyncLocalStorage } from "node:async_hooks";

export { ASK_USER_TOOL };

/** What a host wires to actually put a question to a person and wait. Absent, a
 *  question honestly reports that nothing can ask it. */
export type AskUserCollector = (question: {
  question: string;
  choices?: string[];
  /** The row the answer will be recorded under, so a surface can correlate a
   *  reply that arrives out of band. */
  questionId: string;
  threadId: string;
}) => Promise<Json>;

interface AskTurn {
  threadId: string;
}

const askTurns = new AsyncLocalStorage<AskTurn>();

/** Run one turn with `ask_user` bound to its thread. Everything the turn awaits —
 *  including a tool call several frames deep — sees this thread and no other. */
export function withAskUserTurn<T>(turn: AskTurn, run: () => Promise<T>): Promise<T> {
  return askTurns.run(turn, run);
}

/**
 * The one-tool registry, composed alongside the others so the guard, the audit
 * trail and `find_tools` see it like any host tool.
 *
 * The name has to resolve: the building-apps skill teaches `ask_user` BY NAME as
 * "the one ask_user door", and a skill body is copied to a harness verbatim
 * rather than translated.
 */
export function askUserTools(store: VendoStore, collect?: AskUserCollector): ToolRegistry {
  // Resolved on FIRST USE, never at compose. `threadStore` reaches for the store's
  // SQL handle immediately, and `createVendo` is called at module init in the
  // common edge wiring, where Workers forbids work in global scope — the
  // portability gate caught exactly this ("Unknown VendoStore handle" from
  // `dbFor`, inside `createVendo`). A store with no SQL handle now composes fine
  // and only fails if a question is actually asked.
  let threads: ReturnType<typeof threadStore> | undefined;
  const answers = (): ReturnType<typeof threadStore> => (threads ??= threadStore(store));
  const ports: AskUserPorts = {
    // Read at CALL time, not at compose: the getter is what makes one registry
    // serve every concurrent turn correctly.
    get threadId(): string {
      return askTurns.getStore()?.threadId ?? "";
    },
    // The store's guarded gate: one statement, sourced from `vendo_threads`
    // filtered by this principal, so a thread that is not theirs writes nothing.
    record: (principal: Principal, answer) => answers().recordAnswer(principal, {
      threadId: answer.threadId as never,
      questionId: answer.questionId,
      answer: answer.answer,
    }),
    ...(collect === undefined ? {} : {
      collect: async (input) => {
        const turn = askTurns.getStore();
        if (turn === undefined) {
          // No turn, no thread to record into. Refusing beats collecting an
          // answer we could not attribute to a conversation.
          throw new Error("ask_user was called outside a turn");
        }
        // `questionId` is the SERVER-MINTED row id the answer will be recorded
        // under, passed through verbatim so a surface that takes the reply on a
        // separate request correlates the two on the id that will really be used.
        return collect({ ...input, threadId: turn.threadId });
      },
    }),
  };
  return askUserRegistry(ports);
}
