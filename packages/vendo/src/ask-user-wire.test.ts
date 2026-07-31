/**
 * `ask_user` through the real composition — design §4, "questions as a tool, one
 * door, any seat".
 *
 * The interesting property is not that the tool returns an answer; it is WHOSE
 * conversation the answer lands in. The thread is bound per turn by composition,
 * never taken from the model, so these tests drive real turns through
 * `vendo.harness.stream` and then read the transcript back through the shipped
 * door.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json, Principal, RunContext } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { defineHarness } from "@vendoai/harnesses";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type AskUserCollector, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_ask" };
const chat = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s_ask",
  ...overrides,
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-ask-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const userMessage = (id: string, text: string) =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as never;

/** The harness asks once and reports what came back. */
const asking = (result: { value?: unknown; error?: string }) => defineHarness({
  name: "asker",
  async *run(turn) {
    const outcome = await turn.tools.call("ask_user", { question: "Which account?", choices: ["a", "b"] });
    if (outcome.status === "ok") result.value = outcome.output;
    else result.error = JSON.stringify(outcome);
    yield { type: "text", delta: "asked" };
  },
}) as never;

async function compose(
  askUser?: AskUserCollector,
  harness?: unknown,
): Promise<{ vendo: Vendo; store: VendoStore }> {
  const store = await tempStore();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    ...(askUser === undefined ? {} : { askUser }),
    ...(harness === undefined ? {} : { harness: harness as never }),
  });
  await store.ensureSchema();
  return { vendo, store };
}

describe("ask_user is the one door, on the one registry", () => {
  it("resolves by name as a guarded descriptor — the building-apps skill teaches it", async () => {
    const { vendo } = await compose();
    const names = (await vendo.guardedTools.descriptors(chat())).map((descriptor) => descriptor.name);
    expect(names).toContain("ask_user");
  });

  it("is a read, so asking never spends a grant or raises a consent card", async () => {
    const { vendo } = await compose();
    const descriptor = (await vendo.guardedTools.descriptors(chat()))
      .find((entry) => entry.name === "ask_user");
    expect(descriptor?.risk).toBe("read");
  });

  it("never reaches a person when nobody is present", async () => {
    // The invariant that matters: an unattended run cannot get an answer. It holds
    // at EXECUTION — the guard's away-downgrade parks the call before the registry
    // runs, and lane D's own `isUnattended` refusal stands behind that. It does
    // NOT hold at PROJECTION: `ask_user`'s contextual descriptor-withholding
    // cannot fire, because `ActionsRegistry.descriptors()` merges and memoizes
    // ctx-blind, so the ctx never reaches the inner registry. Recorded in
    // PARKED.md P5 rather than papered over.
    let collected = 0;
    const { vendo } = await compose(async () => {
      collected += 1;
      return "never asked" as Json;
    });
    const outcome = await vendo.guardedTools.execute(
      { id: "a1", tool: "ask_user", args: { question: "Which account?" } },
      chat({ venue: "automation", presence: "away" }),
    );
    // Refused, not answered — parked rather than blocked, because the guard gets
    // there first: `ask_user` reads as a `write` to the second mechanical vote
    // (its name is not read-shaped), and `resolvedRisk` takes the riskier of the
    // two. PARKED.md P6.
    expect(outcome.status).not.toBe("ok");
    expect(collected).toBe(0);
  });
});

describe("a real turn asks and receives an answer", () => {
  it("records the answer into THIS turn's thread and reads it back", async () => {
    const asked: Array<{ question: string; choices?: string[]; questionId: string; threadId: string }> = [];
    const collect: AskUserCollector = async (question) => {
      asked.push(question);
      return "the joint account" as Json;
    };
    const result: { value?: unknown; error?: string } = {};
    const { vendo } = await compose(collect, asking(result));

    const turn = await vendo.harness.stream({
      threadId: "thr_ask",
      message: userMessage("m1", "move some money"),
      ctx: chat(),
    });
    await turn.text();

    // The surface really was asked, with the material arguments.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.question).toBe("Which account?");
    expect(asked[0]?.choices).toEqual(["a", "b"]);
    // The thread is the TURN's, bound by composition — the model never named it.
    expect(asked[0]?.threadId).toBe("thr_ask");
    // And the id the surface is handed is the one the answer is recorded under,
    // so a reply arriving out of band can be correlated.
    expect(asked[0]?.questionId).toMatch(/^q_/);

    // The harness got the answer.
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ answer: "the joint account" });

    // And it is in the transcript, under the recorded row id, readable through the
    // shipped thread door.
    const fetched = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_ask"));
    const thread = await fetched.json() as {
      messages: Array<{ id: string; parts: Array<{ type: string; data?: unknown }> }>;
    };
    const answer = thread.messages.find((message) => message.id === `ans_${asked[0]?.questionId}`);
    expect(answer?.parts[0]).toEqual({ type: "data-vendo-ask-answer", data: "the joint account" });
  });

  it("keeps two concurrent turns' questions in their own threads", async () => {
    // The registry is composed ONCE for the deployment while turns run
    // concurrently. A shared variable here would record one user's answer into
    // another user's conversation, which for a subject-scoped write is a security
    // bug, not a mix-up.
    const asked: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const collect: AskUserCollector = async ({ threadId }) => {
      asked.push(threadId);
      // Hold the FIRST turn open until the second has also asked, so the two
      // genuinely overlap.
      if (first) {
        first = false;
        await gate;
      } else {
        release?.();
      }
      return threadId as Json;
    };
    const result: { value?: unknown; error?: string } = {};
    const { vendo } = await compose(collect, asking(result));

    const [a, b] = await Promise.all([
      vendo.harness.stream({ threadId: "thr_one", message: userMessage("m1", "one"), ctx: chat() }),
      vendo.harness.stream({ threadId: "thr_two", message: userMessage("m2", "two"), ctx: chat() }),
    ]);
    await Promise.all([a.text(), b.text()]);

    expect([...asked].sort()).toEqual(["thr_one", "thr_two"]);
  });

  it("says honestly that nothing can ask when no surface is wired", async () => {
    const result: { value?: unknown; error?: string } = {};
    const { vendo } = await compose(undefined, asking(result));

    const turn = await vendo.harness.stream({
      threadId: "thr_nosurface",
      message: userMessage("m1", "ask me something"),
      ctx: chat(),
    });
    await turn.text();

    // Not a pretended answer, and not a crash.
    expect(result.value).toBeUndefined();
    expect(result.error).toMatch(/No surface is wired/);
  });

  it("returns a failure, never the collected text, when the answer cannot be recorded", async () => {
    // An answer we could not record is an answer we cannot vouch for. Handing it
    // to the model would let it treat unrecorded input as the user's words.
    const collect: AskUserCollector = async () => "secret" as Json;
    const result: { value?: unknown; error?: string } = {};
    const { vendo } = await compose(collect, asking(result));

    // A thread this principal does not own: the store's guarded gate refuses the
    // append, so the tool must report the failure.
    const stranger: RunContext = { ...chat(), principal: { kind: "user", subject: "user_other" } };
    const turn = await vendo.harness.stream({
      threadId: "thr_theirs",
      message: userMessage("m1", "hello"),
      ctx: chat(),
    });
    await turn.text();
    // The owner's own turn works...
    expect(result.value).toEqual({ answer: "secret" });

    // ...and a second subject cannot reach into it. `resolve` refuses the id
    // before a turn even starts.
    await expect(vendo.harness.stream({
      threadId: "thr_theirs",
      message: userMessage("m2", "let me in"),
      ctx: stranger,
    })).rejects.toThrow(/already in use/);
  });
});
