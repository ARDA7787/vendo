import type { RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { ASK_USER_TOOL, askUserRegistry } from "./ask-user.js";

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "user_alice" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...overrides,
});

const call = (args: unknown) => ({ id: "call_1", tool: ASK_USER_TOOL, args: args as never });

const ports = (overrides: Partial<Parameters<typeof askUserRegistry>[0]> = {}) => ({
  threadId: "thr_1",
  record: async () => undefined,
  collect: async () => ({ text: "the savings one" }),
  ...overrides,
});

describe("ask_user — questions as a tool, one door, any seat (design §4)", () => {
  it("is named ask_user and is a read: asking costs no grant", async () => {
    const [descriptor] = await askUserRegistry(ports()).descriptors();
    expect(descriptor?.name).toBe("ask_user");
    expect(descriptor?.risk).toBe("read");
  });

  it("records the answer against the asking principal and hands it back", async () => {
    const recorded: unknown[] = [];
    const registry = askUserRegistry(ports({
      record: async (principal, answer) => { recorded.push({ subject: principal.subject, answer }); },
    }));

    const outcome = await registry.execute(call({ question: "Which account?" }), ctx());

    expect(outcome).toEqual({ status: "ok", output: { answer: { text: "the savings one" } } });
    expect(recorded).toEqual([{
      subject: "user_alice",
      answer: {
        threadId: "thr_1",
        // Server-minted: the model cannot name the row its answer lands in.
        questionId: expect.stringMatching(/^q_session_1_/) as unknown as string,
        answer: { text: "the savings one" },
      },
    }]);
  });

  it("IGNORES a model-supplied questionId (finding 5)", async () => {
    // Accepting one let the model reuse an id, which made the store drop the
    // user's real answer while an earlier one stood as theirs.
    const seen: string[] = [];
    const registry = askUserRegistry(ports({
      record: async (_principal, answer) => { seen.push(answer.questionId); },
    }));

    await registry.execute(call({ question: "Which?", questionId: "q_reused" }), ctx());
    await registry.execute(call({ question: "Which?", questionId: "q_reused" }), ctx());

    expect(seen).not.toContain("q_reused");
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("gives the MODEL no way to choose which thread an answer lands in", async () => {
    // The security review of the store gate showed why this matters: a
    // caller-chosen thread id is an attempt to write into someone else's
    // conversation, and the transcript is what the next turn reads. The thread is
    // bound per turn by the caller, so a smuggled id is simply ignored.
    const recorded: Array<{ threadId: string }> = [];
    const registry = askUserRegistry(ports({
      record: async (_principal, answer) => { recorded.push({ threadId: answer.threadId }); },
    }));

    await registry.execute(
      call({ question: "Which account?", questionId: "q_1", threadId: "thr_victim" }),
      ctx(),
    );

    expect(recorded).toEqual([{ threadId: "thr_1" }]);
  });

  it("REFUSES in an unattended run — there is nobody there to ask", async () => {
    // A question with no one to answer it is not a question. An automation that
    // needs an answer must fail with a card, not hang and not invent one.
    const registry = askUserRegistry(ports({
      record: async () => { throw new Error("must not record"); },
      collect: async () => { throw new Error("must not collect"); },
    }));

    const outcome = await registry.execute(
      call({ question: "Which account?", questionId: "q_1" }),
      ctx({ venue: "automation", presence: "away" }),
    );

    expect(outcome.status).toBe("blocked");
  });

  it("is not projected into an unattended run at all", async () => {
    const projected = await askUserRegistry(ports()).descriptors({ venue: "automation", presence: "away" });
    expect(projected).toEqual([]);
  });

  it("rejects a blank question rather than showing an empty card", async () => {
    const outcome = await askUserRegistry(ports()).execute(
      call({ question: "  ", questionId: "q_1" }),
      ctx(),
    );
    expect(outcome.status).toBe("error");
  });

  it("surfaces a refused answer write as an error, never as a fabricated answer", async () => {
    // If the store's subject gate ever fires here, the model must NOT be handed
    // text it can treat as the user's own words.
    const registry = askUserRegistry(ports({
      record: async () => { throw new Error("thread does not belong to this subject"); },
      collect: async () => ({ text: "spoofed" }),
    }));

    const outcome = await registry.execute(call({ question: "Which?", questionId: "q_1" }), ctx());

    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("spoofed");
  });

  it("mints a questionId when the model omits one, so two questions never collide", async () => {
    const seen: string[] = [];
    const registry = askUserRegistry(ports({
      record: async (_principal, answer) => { seen.push(answer.questionId); },
    }));

    await registry.execute(call({ question: "First?" }), ctx());
    await registry.execute(call({ question: "Second?" }), ctx());

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
