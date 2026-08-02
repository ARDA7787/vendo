import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VendoError, type HarnessEvent, type Json, type ToolResult, type Turn } from "@vendoai/core";
import { afterEach, describe, expect, test } from "vitest";
// The REAL box door, driven over a fake transport — see the block comment below.
// A package subpath, not a relative climb: the door is the wire contract between
// these two blocks, and `harnesses → apps` is a layer-legal edge.
import { createSessionRoutes } from "@vendoai/apps/box-door";
import { assertHarnessComposable } from "../compose.js";
import { createTurnState } from "../harness-state.js";
import { provideHarnessAdapters } from "../harness-sandbox.js";
import { testWorkspace, unusedModels, userMessage } from "../test-doubles.test-util.js";
import { claudeCode, inferenceEnv, promptFor, rewindFor } from "./index.js";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike, type SandboxMachineLike } from "./box.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * A stand-in for a REAL box: it speaks the same control-port wire the machine
 * image speaks (`packages/apps/box/turn-routes.mjs`), so what is under test is
 * our driver and our sync-back — never a mock of our own code. The SDK loop is
 * the one thing scripted, because a unit test cannot run a model.
 */
/**
 * A stand-in for a real box that speaks the REAL protocol: the fake machine's
 * `request()` is a thin transport adapter over the ACTUAL box door
 * (`packages/apps/box/turn-routes.mjs`), with only the SDK session scripted.
 *
 * A hand-written fake let a live BLOCKER hide: it accepted `hello`
 * unconditionally, so it modelled a protocol the real box does not implement.
 * Driving the real door means that class cannot come back.
 *
 * One provider behaviour is modelled deliberately because it is load bearing: a
 * CREATED machine boots with NO token, since create-time envs never reach a
 * template's start command. There is no resumed-machine case any more — a
 * conversation box is destroyed rather than snapshotted.
 */
type BoxScript = (box: {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  emit: (event: Record<string, unknown>) => void;
  /** What the box was told to think with — `Turn.system` plus the workspace
   *  brief, as it arrives through the real door. */
  systemPrompt?: string;
  /** Writes even over a read-only `/host` bind — the box's chmod is advisory, so
   *  an agent that defeats it is exactly the case the sync-back seam must catch. */
  write: (workspacePath: string, text: string) => void;
  read: (workspacePath: string) => string | undefined;
  /** The provider reaping the machine mid-turn. A script that merely THROWS is a
   *  failing thinker, which is a different fact. */
  kill: () => void;
  resume?: string;
}) => Promise<void>;

interface FakeBox extends SandboxMachineLike {
  /** The materialized workspace on this machine's disk. */
  root: string;
  destroyed: boolean;
  /** How many messages this box's live session has answered. */
  messages: number;
  env: Record<string, string>;
}

const boxRoots: string[] = [];
afterEach(() => {
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const diskPath = (root: string, workspacePath: string): string =>
  path.join(root, workspacePath.replace(/^\/+/, ""));

function fakeSandbox(script: BoxScript): SandboxAdapterLike & { boxes: FakeBox[] } {
  const adapter = {
    boxes: [] as FakeBox[],
    async create(spec: { env: Record<string, string> }) {
      return makeBox(adapter, script, spec.env);
    },
    async destroy() { /* teardown by ref; nothing to do here */ },
  };
  return adapter;
}

function makeBox(
  adapter: { boxes: FakeBox[] },
  script: BoxScript,
  env: Record<string, string>,
): FakeBox {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-fakebox-"));
  boxRoots.push(root);

  const box = {
    id: `box_${adapter.boxes.length}`,
    root,
    env,
    destroyed: false,
    messages: 0,
  } as FakeBox;

  const routes = createSessionRoutes({
    root,
    // A CREATED machine boots with NO token: the provider does not hand
    // create-time envs to a template's start command, so the first hello claims it.
    token: "",
    env: {},
    /** The live session. Opened once per box; `send()` plays the script. */
    openSession: (input: {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      emit: (event: Record<string, unknown>) => void;
      onFileWritten?: (path: string | undefined) => void;
      resume?: string;
      systemPrompt?: string;
    }) => ({
      async send() {
        box.messages += 1;
        await script({
          callTool: input.callTool,
          emit: input.emit,
          ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
          write: (workspacePath, text) => {
            const target = diskPath(root, workspacePath);
            mkdirSync(path.dirname(target), { recursive: true });
            try {
              chmodSync(target, 0o644);
            } catch {
              // Not there yet, or already writable.
            }
            writeFileSync(target, text);
            // The real SDK's PostToolUse hook fires on every write; the fake must
            // too, or the hot-path sync has nothing to react to.
            input.onFileWritten?.(target);
          },
          kill: () => { box.destroyed = true; },
          read: (workspacePath) => {
            try {
              return readFileSync(diskPath(root, workspacePath), "utf8");
            } catch {
              return undefined;
            }
          },
          ...(input.resume === undefined ? {} : { resume: input.resume }),
        });
      },
      async interrupt() { /* the turn is cut short; the session lives */ },
      async end() { /* the box is going away */ },
    }),
  }) as {
    handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
      => Promise<{ status: number; body: unknown }>;
  };

  box.destroy = async () => { box.destroyed = true; };
  box.request = async (req) => {
    if (box.destroyed) throw new VendoError("not-found", "machine is gone");
    const payload = req.body === undefined
      ? {}
      : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as Record<string, unknown>;
    const answer = await routes.handle(req.method, req.path, (req.headers ?? {}) as Record<string, string>, payload);
    return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
  };

  adapter.boxes.push(box);
  return box;
}

let threadSeq = 0;

afterEach(async () => { await disposeSessionMachines(); });

interface TurnDouble {
  turn: Turn<never>;
  workspace: ReturnType<typeof testWorkspace>;
  calls: Array<{ name: string; args: Json }>;
  state: ReturnType<typeof createTurnState>;
}

function makeTurn(input: {
  files?: Record<string, string>;
  tools?: Array<{ name: string; title: string; description: string }>;
  answer?: (name: string, args: Json) => ToolResult;
  state?: string;
  /** The pool keys on the first message's id, so a test that wants the SAME
   *  session across two turns names it. */
  thread?: string;
  /** `Turn.threadId` — the pool's FIRST key (contract amendment ccaba80a7).
   *  Tests that omit it exercise the untyped-caller fallback above. */
  threadId?: string;
  messages?: Array<{ id: string; text: string }>;
} = {}): TurnDouble {
  const workspace = testWorkspace(input.files ?? {});
  const calls: Array<{ name: string; args: Json }> = [];
  const state = createTurnState(input.state);
  const messages = (input.messages ?? [{ id: input.thread ?? `m_${(threadSeq += 1)}`, text: "make me a dashboard" }])
    .map((m) => userMessage(m.id, m.text));
  const turn = {
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    messages,
    tools: {
      list: async () => (input.tools ?? [{ name: "maple_invoices_list", title: "List invoices", description: "d" }])
        .map((t) => ({ ...t, risk: "read" as const })),
      call: async (name: string, args: Json) => {
        calls.push({ name, args });
        return input.answer?.(name, args) ?? { status: "ok" as const, output: { ok: true } };
      },
    },
    skills: { list: async () => [], load: async () => "" },
    workspace,
    models: unusedModels(),
    state,
    options: {} as never,
    signal: new AbortController().signal,
    interactive: true,
    system: "PRODUCT BRIEF",
  } as unknown as Turn<never>;
  return { turn, workspace, calls, state };
}

const drain = async (harness: ReturnType<typeof claudeCode>, turn: Turn<never>): Promise<HarnessEvent[]> => {
  const events: HarnessEvent[] = [];
  for await (const event of harness.run(turn as never)) events.push(event);
  return events;
};

describe("the boot gate — a spawned harness with no machine to live on (design §9)", () => {
  test("FAILS closed: claudeCode() with no sandbox adapter is a boot error", () => {
    expect(() => assertHarnessComposable(claudeCode() as never, {})).toThrow(VendoError);
    expect(() => assertHarnessComposable(claudeCode() as never, {})).toThrow(/needs a sandbox adapter/);
  });

  test("passes with an adapter composed", () => {
    expect(() => assertHarnessComposable(claudeCode() as never, { sandbox: {} })).not.toThrow();
  });

  test("machine:\"local\" is the explicit opt-in that needs no machine", () => {
    expect(() => assertHarnessComposable(claudeCode({ machine: "local" }) as never, {})).not.toThrow();
    expect(claudeCode({ machine: "local" }).requires?.sandbox).toBeUndefined();
  });

  test("the harness names itself exactly what the compose fixture expects", () => {
    expect(claudeCode().name).toBe("claude-code");
  });
});

describe("options — declared, then overridable per turn", () => {
  test("only the model knobs are per-turn overridable", () => {
    const shape = (claudeCode().optionsSchema as never as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["effort", "maxTurns", "model"]);
  });

  test("m1 · `machine` is construction-time only — a per-turn option cannot move the SDK onto the host", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "boxed" }); });
    const { turn } = makeTurn();
    // A wire caller smuggling the deployment knob into a request.
    (turn as unknown as { options: unknown }).options = { machine: "local" };
    expect(await drain(claudeCode({ sandbox }), turn)).toContainEqual({ type: "text", delta: "boxed" });
    // A box was still used: the SDK never came near the host's own server.
    expect(sandbox.boxes).toHaveLength(1);
  });
});

describe("E7 · the credential law — build list item 8", () => {
  const withEnv = <T>(vars: Record<string, string | undefined>, body: () => T): T => {
    const source = process.env as Record<string, string | undefined>;
    const before = Object.fromEntries(Object.keys(vars).map((key) => [key, source[key]]));
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete source[key];
      else source[key] = value;
    }
    try {
      return body();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete source[key];
        else source[key] = value;
      }
    }
  };

  test("only the recorded v0 inference exception enters the machine", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://gateway.example/v1/",
      E2B_API_KEY: "e2b-should-never-travel",
      DATABASE_URL: "postgres://should-never-travel",
      VENDO_API_KEY: "vnd-should-never-travel",
    }, inferenceEnv);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-test",
      // The bare origin: the SDK wants no /v1 and no trailing slash.
      ANTHROPIC_BASE_URL: "https://gateway.example",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  test("the box's own VENDO_INFERENCE_* wiring is the same one exception", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: "gw-key",
      VENDO_INFERENCE_URL: "https://console.vendo.run/api/v1",
    }, inferenceEnv);
    expect(env["ANTHROPIC_API_KEY"]).toBe("gw-key");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://console.vendo.run/api");
  });

  test("no inference credential at all still yields no OTHER credential", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      E2B_API_KEY: "e2b-should-never-travel",
    }, inferenceEnv);
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_AUTOUPDATER",
    ]);
  });
});

describe("promptFor — the truth is ours", () => {
  test("a resumed session is asked only what the user just said", () => {
    const messages = [userMessage("m1", "first"), userMessage("m2", "second")];
    expect(promptFor(messages, true)).toBe("second");
  });

  test("a fresh session — a swap mid-conversation — is re-seeded from OUR transcript", () => {
    const messages = [userMessage("m1", "make a dashboard"), userMessage("m2", "now make it blue")];
    const prompt = promptFor(messages, false);
    expect(prompt).toContain("make a dashboard");
    expect(prompt).toContain("now make it blue");
  });
});

describe("one box per conversation, destroyed when it goes idle (design §9)", () => {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test("an idle box is DESTROYED, not snapshotted — there is no resume ref to keep", async () => {
    // The snapshot existed to make a woken session resumable. A live session has
    // no cold start to optimise away, so the box simply goes, and the store plus
    // our transcript are what the next message recovers from.
    const sandbox = fakeSandbox(async () => undefined);
    const first = await boxMachine({ sandbox, threadId: "thr_idle", env: {}, idleTtlMs: 5 });
    await first.release();
    await wait(60);

    expect(sandbox.boxes[0]?.destroyed).toBe(true);
    // Nothing on the adapter was ever asked to snapshot or resume: the whole
    // mechanism is gone, not merely unused.
    expect("snapshot" in sandbox.boxes[0]!).toBe(false);
    expect("resume" in sandbox).toBe(false);
  });

  test("a box whose conversation is mid-message is NOT destroyed", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    await boxMachine({ sandbox, threadId: "thr_busy", env: {}, idleTtlMs: 5 });
    // Never released: the message is still running.
    await wait(60);
    expect(sandbox.boxes[0]?.destroyed).toBe(false);
  });

  test("a WARM box carries the conversation, so the next message neither re-materializes nor re-seeds", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const first = await boxMachine({ sandbox, threadId: "thr_warm", env: {}, idleTtlMs: 5_000 });
    // A box only becomes warm once it has answered a message.
    expect(first.carriesSession).toBe(false);
    await first.send({ prompt: "hi", tools: [], callTool: async () => ({ status: "ok", output: {} }), emit: () => undefined });
    await first.release();

    const second = await boxMachine({ sandbox, threadId: "thr_warm", env: {} });
    expect(second.carriesSession).toBe(true);
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("a box the provider reaped is replaced, and the replacement says it carries nothing", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const first = await boxMachine({ sandbox, threadId: "thr_reaped", env: {}, idleTtlMs: 5_000 });
    await first.send({ prompt: "hi", tools: [], callTool: async () => ({ status: "ok", output: {} }), emit: () => undefined });
    await first.release();
    // Gone without us asking — a provider reap, an idle policy on their side.
    sandbox.boxes[0]!.destroyed = true;

    const second = await boxMachine({ sandbox, threadId: "thr_reaped", env: {} });
    // The harness must re-materialize and re-seed rather than resume a session
    // no disk holds, and `carriesSession: false` is what tells it to.
    expect(second.carriesSession).toBe(false);
    expect(sandbox.boxes).toHaveLength(2);
  });

  test("m4 · the box map keys on turn.threadId when the runtime supplies one", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "hi" }); });
    const harness = claudeCode({ sandbox });
    for (const messageId of ["m_a", "m_b"]) {
      const { turn } = makeTurn({ thread: messageId });
      // Two different first messages, ONE conversation.
      (turn as unknown as { threadId: string }).threadId = "thr_named";
      await drain(harness, turn);
    }
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("m4 · two threads with NO identity never share a machine, a session, or a workspace", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "hi" }); });
    const harness = claudeCode({ sandbox });
    for (let index = 0; index < 2; index += 1) {
      const { turn } = makeTurn();
      (turn as unknown as { messages: unknown[] }).messages = [];
      await drain(harness, turn);
    }
    expect(sandbox.boxes).toHaveLength(2);
  });

  test("§1.4 · no box is held immune while a guarded call waits for a human", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    let aliveDuringCall: boolean | undefined;
    const machine = await boxMachine({ sandbox, threadId: "thr_lease", env: {}, idleTtlMs: 20 });
    // The driver arms the idle timer around every host-side call, so a box may be
    // reclaimed under an approval wait exactly as it may under an idle gap.
    const box = sandbox.boxes[0]!;
    const request = box.request.bind(box);
    box.request = async (req) => {
      if (req.path.endsWith("/poll")) {
        // Park an ask so the driver goes and executes it host-side.
        return {
          status: 200,
          headers: {},
          body: encoder.encode(JSON.stringify({
            events: [], cursor: 0, asks: [{ id: "a1", name: "t", args: {} }], done: false,
          })),
        };
      }
      return request(req);
    };
    const running = machine.send({
      prompt: "p",
      tools: [],
      callTool: async () => {
        // NOTHING releases the box here — the driver itself must have armed the
        // idle timer for the duration of the call.
        await wait(60);
        aliveDuringCall = !sandbox.boxes[0]!.destroyed;
        return { status: "ok", output: {} };
      },
      emit: () => undefined,
    }).catch(() => undefined);
    await running;
    expect(aliveDuringCall).toBe(false);
  });
});

describe("§1.3 · a prefix truncation uses the SDK's NATIVE rewind", () => {
  test("an APPEND resumes the session untouched", () => {
    expect(rewindFor({ sessionId: "s", covers: 3, rewind: [{ at: 3, uuid: "u3" }] }, 5))
      .toEqual({ resume: "s" });
  });

  test("an EQUAL-length history is a REGENERATE — rewind past the reply the user threw away", () => {
    // `covers` counts the answering turn's inputs, so the discarded reply sits
    // at transcript index `covers` and its own checkpoint (at 3) is unusable:
    // resuming there still remembers the deleted answer. The previous turn's
    // checkpoint is the target. (A real last-message EDIT never reaches here —
    // the runtime clears the state for a differing overlap.)
    expect(rewindFor({ sessionId: "s", covers: 3, rewind: [{ at: 1, uuid: "u1" }, { at: 3, uuid: "u3" }] }, 3))
      .toEqual({ resume: "s", resumeAt: "u1" });
  });

  test("a regenerate with no checkpoint before the discarded reply drops the session and re-seeds", () => {
    expect(rewindFor({ sessionId: "s", covers: 3, rewind: [{ at: 3, uuid: "u3" }] }, 3)).toEqual({});
  });

  test("a SHORTER transcript rewinds to the checkpoint that predates the edit", () => {
    const state = { sessionId: "s", covers: 5, rewind: [{ at: 1, uuid: "u1" }, { at: 3, uuid: "u3" }] };
    // The user edited message index 2 and resent: history is 0..1, the new
    // message is at 2, so the newest usable checkpoint is the one at 1.
    // A checkpoint AT the incoming length answered a transcript that still
    // contained the message the user just replaced, so only strictly-older ones
    // are usable.
    expect(rewindFor(state, 4)).toEqual({ resume: "s", resumeAt: "u3" });
    expect(rewindFor(state, 2)).toEqual({ resume: "s", resumeAt: "u1" });
  });

  test("a truncation past every checkpoint drops the session and re-seeds — never wrong, only slower", () => {
    expect(rewindFor({ sessionId: "s", covers: 5, rewind: [{ at: 3, uuid: "u3" }] }, 1)).toEqual({});
  });

  test("no session means nothing to rewind", () => {
    expect(rewindFor({}, 3)).toEqual({});
  });

  test("end to end: turn 2 on an EDITED history resumes at turn 1's checkpoint", async () => {
    const resumes: Array<{ resume?: string; resumeAt?: string }> = [];
    const sandbox = fakeSandbox(async (box) => {
      box.emit({ type: "session", sessionId: "sess_rw" });
      box.emit({ type: "checkpoint", uuid: "uuid_turn1" });
    });
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => {
      const box = await original(spec);
      const request = box.request.bind(box);
      box.request = async (req) => {
        if (req.path === "/session/message" && req.body !== undefined) {
          const body = JSON.parse(decoder.decode(req.body as Uint8Array));
          resumes.push({ resume: body["resume"], resumeAt: body["resumeAt"] });
        }
        return request(req);
      };
      return box;
    };
    const harness = claudeCode({ sandbox });
    const first = makeTurn({ thread: "thr_rw" });
    await drain(harness, first.turn);
    const carried = first.state.pending().value!;
    expect(JSON.parse(carried)).toMatchObject({
      sessionId: "sess_rw",
      covers: 1,
      rewind: [{ at: 1, uuid: "uuid_turn1" }],
    });

    // A THIRD message would be an append; two is the user resending an edit.
    const edited = makeTurn({
      thread: "thr_rw",
      state: JSON.stringify({ sessionId: "sess_rw", covers: 3, rewind: [{ at: 1, uuid: "uuid_turn1" }] }),
      messages: [{ id: "thr_rw", text: "make me a dashboard" }, { id: "m_edit", text: "no, a chart" }],
    });
    await drain(harness, edited.turn);
    console.log("[rewind resumes]", JSON.stringify(resumes));
    expect(resumes[1]).toEqual({ resume: "sess_rw", resumeAt: "uuid_turn1" });
  });
});

describe("a turn on a real box wire", () => {
  test("the workspace is materialized, the box edits it, and the diff lands in the store", async () => {
    const sandbox = fakeSandbox(async (box) => {
      expect(box.read("/user/apps/app_1/app.vendo")).toBe("<App/>");
      box.write("/user/apps/app_1/app.vendo", "<App>edited</App>");
      box.emit({ type: "text", delta: "Done." });
      box.emit({ type: "session", sessionId: "sess_1" });
    });
    const { turn, workspace, state } = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    const events = await drain(claudeCode({ sandbox }), turn);

    expect(events).toContainEqual({ type: "text", delta: "Done." });
    expect(await workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App>edited</App>");
    // The native session ref is carried, opaquely, in turn.state (§1.3).
    expect(JSON.parse(state.pending().value!)).toMatchObject({ sessionId: "sess_1" });
  });

  test("a projected tool executes HOST-side, once, through turn.tools.call", async () => {
    let answered: unknown;
    const sandbox = fakeSandbox(async (box) => {
      answered = await box.callTool("maple_invoices_list", { limit: 3 });
    });
    const { turn, calls } = makeTurn();
    await drain(claudeCode({ sandbox }), turn);
    expect(calls).toEqual([{ name: "maple_invoices_list", args: { limit: 3 } }]);
    expect(answered).toEqual({ status: "ok", output: { ok: true } });
  });

  test("a guard denial reaches the box as a denial it can narrate", async () => {
    let answered: unknown;
    const sandbox = fakeSandbox(async (box) => { answered = await box.callTool("maple_invoices_pay", {}); });
    const { turn } = makeTurn({
      answer: () => ({ status: "denied", reason: "You'll need to approve that." }),
    });
    await drain(claudeCode({ sandbox }), turn);
    expect(answered).toEqual({ status: "denied", reason: "You'll need to approve that." });
  });

  test("D2 · Turn.system reaches the box WHOLE, with the embedding note after it", async () => {
    // The D2 plumbing question, measured rather than read: the composed brief
    // (which carries "Never claim a tool ran unless its result confirms that it
    // did") is what `vendo()` thinks with, and it must be what the box thinks
    // with too. It is — so D2's invented automation is not a dropped brief.
    let brief: string | undefined;
    const sandbox = fakeSandbox(async (box) => { brief = box.systemPrompt; });
    await drain(claudeCode({ sandbox }), makeTurn().turn);
    expect(brief).toContain("PRODUCT BRIEF");
    // Ours first, the embedding note after — never the other way round, and
    // never instead. The note is now a few lines, not the old wall: Claude Code
    // already knows how to work in a directory, so all we add is the EMBEDDING.
    expect(brief?.startsWith("PRODUCT BRIEF")).toBe(true);
    expect(brief).toContain("embedded in this product");
    expect(brief).toContain("app.vendo");
  });

  test("the tool listing the box sees is the CURATED one, with its schemas", async () => {
    let projected: unknown;
    const sandbox = fakeSandbox(async () => undefined);
    const { turn } = makeTurn();
    // Intercept what the driver sends to /session/message.
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => {
      const box = await original(spec);
      const request = box.request.bind(box);
      box.request = async (req) => {
        if (req.path === "/session/message" && req.body !== undefined) {
          projected = JSON.parse(decoder.decode(req.body as Uint8Array))["tools"];
        }
        return request(req);
      };
      return box;
    };
    await drain(claudeCode({ sandbox }), turn);
    expect(projected).toEqual([
      { name: "maple_invoices_list", title: "List invoices", description: "d" },
    ]);
  });

  test("/user/scratch never leaves the box, and /host is never written back", async () => {
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/scratch/notes.txt", "junk");
      box.write("/host/skills/a/SKILL.md", "rewritten");
      box.write("/user/memory/keep.md", "kept");
    });
    const { turn, workspace } = makeTurn({ files: { "/host/skills/a/SKILL.md": "original" } });
    await drain(claudeCode({ sandbox }), turn);
    expect(await workspace.exists("/user/scratch/notes.txt")).toBe(false);
    expect(await workspace.readFile("/host/skills/a/SKILL.md")).toBe("original");
    expect(await workspace.readFile("/user/memory/keep.md")).toBe("kept");
  });

  test("a box-side plan write lands MID-TURN, so the skeleton renders before the turn ends", async () => {
    let landed: string[] | undefined;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/apps/app_1/plan.vendo", "plan v1");
      // Stay inside the turn until the host has committed it — a landing after
      // the turn ended would prove nothing about the skeleton.
      await held;
      box.emit({ type: "text", delta: "done" });
    });
    const { turn, workspace } = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    const watcher = setInterval(() => {
      const commit = workspace.commits.find((entry) =>
        entry.changed.includes("/user/apps/app_1/plan.vendo"));
      if (commit !== undefined) { landed = commit.changed; release(); }
    }, 20);
    const guard = setTimeout(release, 8_000);
    await drain(claudeCode({ sandbox }), turn);
    clearInterval(watcher);
    clearTimeout(guard);
    // ONLY the hot path: the mid-turn sync never drags the rest of the tree along.
    expect(landed).toEqual(["/user/apps/app_1/plan.vendo"]);
  }, 15_000);

  test("D5 · a plan for a BRAND-NEW app lands mid-turn too — the skeleton is what a new app needs most", async () => {
    // The measured bug: the hot set was pre-enumerated from files that already
    // existed, so the one case the skeleton exists for — "make me an app" —
    // watched nothing and the user sat through 52.8s of silence.
    let landed: string[] | undefined;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/apps/app_brandnew/plan.vendo", "plan v1");
      await held;
      box.emit({ type: "text", delta: "done" });
    });
    // NO app directory at turn start: only unrelated user files.
    const { turn, workspace } = makeTurn({ files: { "/user/memory/keep.md": "kept" } });
    const watcher = setInterval(() => {
      const commit = workspace.commits.find((entry) =>
        entry.changed.includes("/user/apps/app_brandnew/plan.vendo"));
      if (commit !== undefined) { landed = commit.changed; release(); }
    }, 20);
    const guard = setTimeout(release, 8_000);
    await drain(claudeCode({ sandbox }), turn);
    clearInterval(watcher);
    clearTimeout(guard);
    expect(landed).toEqual(["/user/apps/app_brandnew/plan.vendo"]);
  }, 15_000);

  test("killing the sandbox mid-turn leaves the store untouched, and the next turn recovers", async () => {
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/apps/app_1/app.vendo", "<App>half</App>");
      // The provider reaps the machine mid-turn: every later request throws
      // not-found, so the half-written app can never be read back.
      box.kill();
    });
    const { turn, workspace } = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(claudeCode({ sandbox }), turn);
    expect(await workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App/>");

    await disposeSessionMachines();
    const healthy = fakeSandbox(async (box) => {
      box.write("/user/apps/app_1/app.vendo", "<App>whole</App>");
    });
    const second = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(claudeCode({ sandbox: healthy }), second.turn);
    expect(await second.workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App>whole</App>");
  });

  test("the machine pool keys on Turn.threadId FIRST — a history edit cannot orphan the session", async () => {
    // The amendment's whole point (ccaba80a7): `messages[0].id` changes when
    // the user edits the first message and resends; the thread's identity does
    // not. Same threadId + different first-message id must be ONE machine.
    let creates = 0;
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "ok" }); });
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => { creates += 1; return original(spec); };
    const harness = claudeCode({ sandbox });
    const first = makeTurn({ threadId: "thr_named", messages: [{ id: "m_a", text: "hi" }] });
    await drain(harness, first.turn);
    const second = makeTurn({ threadId: "thr_named", messages: [{ id: "m_edited", text: "hi again" }] });
    await drain(harness, second.turn);
    expect(creates).toBe(1);
  });

  test("D4 · a pooled machine the provider reaped is EVICTED, so the next turn on that thread recovers", async () => {
    // The live half of the kill law. The test above disposes the pool between
    // turns, which is exactly what hid this: in a real server the dead entry
    // stays, and every later turn on that thread was handed the corpse — 0.3s
    // failures for the life of the process, recoverable only by a restart.
    let boxTurn = 0;
    const sandbox = fakeSandbox(async (box) => {
      boxTurn += 1;
      if (boxTurn === 1) {
        box.write("/user/apps/app_1/app.vendo", "<App>half</App>");
        box.kill();
        return;
      }
      box.write("/user/apps/app_1/app.vendo", "<App>whole</App>");
    });
    const harness = claudeCode({ sandbox });
    const first = makeTurn({ thread: "thr_bricked", files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(harness, first.turn);
    expect(await first.workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App/>");

    // SAME thread, SAME process, pool NOT disposed.
    const second = makeTurn({ thread: "thr_bricked", files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(harness, second.turn);
    expect(await second.workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App>whole</App>");
    expect(sandbox.boxes).toHaveLength(2);
  });

  test("one machine per session: a second turn on the same thread reuses it", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "session", sessionId: "sess_1" }); });
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_reuse" }).turn);
    await drain(harness, makeTurn({ thread: "thr_reuse", state: JSON.stringify({ sessionId: "sess_1" }) }).turn);
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("a second turn does not RESUME anything — it continues a session that never stopped", async () => {
    // This is the cc-native change, stated as the thing it replaced. The old
    // shape opened a NEW query() per message and handed it `resume: <sessionId>`
    // to buy back the memory it had just thrown away. A live session never threw
    // it away, so there is nothing to resume: the box is opened once and answers
    // both messages.
    const opens: Array<string | undefined> = [];
    const sandbox = fakeSandbox(async (box) => {
      opens.push(box.resume);
      box.emit({ type: "session", sessionId: "sess_1" });
    });
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_resume" }).turn);
    await drain(harness, makeTurn({ thread: "thr_resume", state: JSON.stringify({ sessionId: "sess_1" }) }).turn);

    // One box, one session, two messages — and no resume ref on either.
    expect(sandbox.boxes).toHaveLength(1);
    expect(sandbox.boxes[0]?.messages).toBe(2);
    expect(opens).toEqual([undefined, undefined]);
  });

  test("a second turn on a WARM box does not re-materialize the workspace", async () => {
    // Proof 1's other half: the box's disk is the conversation's working copy, so
    // resetting it between messages would throw away exactly what the live
    // session is holding open.
    const resets: number[] = [];
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "ok" }); });
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => {
      const box = await original(spec);
      const request = box.request.bind(box);
      box.request = async (req) => {
        if (req.path === "/session/workspace" && req.body !== undefined) {
          const body = JSON.parse(decoder.decode(req.body as Uint8Array)) as { reset?: boolean };
          if (body.reset === true) resets.push(1);
        }
        return request(req);
      };
      return box;
    };
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_mat", files: { "/user/memory/a.md": "one" } }).turn);
    await drain(harness, makeTurn({ thread: "thr_mat", files: { "/user/memory/a.md": "one" } }).turn);
    expect(resets).toHaveLength(1);
  });

  test("a composed adapter reaches a boot-constructed harness through the slot", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "hi" }); });
    const harness = claudeCode();
    provideHarnessAdapters(harness, { sandbox });
    expect(await drain(harness, makeTurn().turn)).toContainEqual({ type: "text", delta: "hi" });
  });

  test("with no adapter anywhere the turn refuses in the consumer voice, never a stack trace", async () => {
    const events = await drain(claudeCode(), makeTurn().turn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(JSON.stringify(events[0])).not.toMatch(/sandbox|adapter|undefined/i);
  });
});
