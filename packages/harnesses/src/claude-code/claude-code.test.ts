import { VendoError, type HarnessEvent, type Json, type ToolResult, type Turn } from "@vendoai/core";
import { afterEach, describe, expect, test } from "vitest";
import { assertHarnessComposable } from "../compose.js";
import { createTurnState } from "../harness-state.js";
import { provideHarnessAdapters } from "../harness-sandbox.js";
import { testWorkspace, unusedModels, userMessage } from "../test-doubles.test-util.js";
import { claudeCode, promptFor } from "./index.js";
import { disposeSessionMachines, type SandboxAdapterLike, type SandboxMachineLike } from "./box.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * A stand-in for a REAL box: it speaks the same control-port wire the machine
 * image speaks (`packages/apps/box/turn-routes.mjs`), so what is under test is
 * our driver and our sync-back — never a mock of our own code. The SDK loop is
 * the one thing scripted, because a unit test cannot run a model.
 */
type BoxScript = (box: {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  emit: (event: Record<string, unknown>) => void;
  write: (workspacePath: string, text: string) => void;
  read: (workspacePath: string) => string | undefined;
  resume?: string;
}) => Promise<void>;

interface FakeBox extends SandboxMachineLike {
  files: Map<string, string>;
  destroyed: boolean;
  snapshots: number;
  env: Record<string, string>;
}

function fakeSandbox(script: BoxScript): SandboxAdapterLike & { boxes: FakeBox[]; failResume?: boolean } {
  const adapter = {
    boxes: [] as FakeBox[],
    failResume: false,
    async create(spec: { env: Record<string, string> }) {
      return makeBox(adapter, script, spec.env);
    },
    async resume(_ref: string) {
      if (adapter.failResume) throw new VendoError("not-found", "snapshot gone");
      return makeBox(adapter, script, {});
    },
    async destroy() { /* sleeping-machine teardown; nothing to do here */ },
  };
  return adapter;
}

function makeBox(
  adapter: { boxes: FakeBox[] },
  script: BoxScript,
  env: Record<string, string>,
): FakeBox {
  const files = new Map<string, string>();
  let token = env["VENDO_BOX_TOKEN"] ?? "";
  const events: Array<Record<string, unknown>> = [];
  let ask: { id: string; name: string; args: unknown } | undefined;
  const answers = new Map<string, (value: unknown) => void>();
  let done = false;
  let running: Promise<void> | undefined;

  const box: FakeBox = {
    id: `box_${adapter.boxes.length}`,
    files,
    env,
    destroyed: false,
    snapshots: 0,
    async snapshot() { box.snapshots += 1; return `fake:${box.id}`; },
    async destroy() { box.destroyed = true; },
    async request(req) {
      const reply = (status: number, body: unknown) => ({
        status,
        headers: {},
        body: encoder.encode(JSON.stringify(body)),
      });
      if (box.destroyed) throw new VendoError("not-found", "machine is gone");
      const payload = req.body === undefined
        ? {}
        : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as Record<string, any>;
      if (req.path === "/turn/token") { token = String(payload["token"]); return reply(200, { ok: true }); }
      if (req.headers?.["x-vendo-box-token"] !== token || token === "") return reply(401, { error: "no token" });

      if (req.path === "/turn/workspace") {
        if (payload["reset"] === true) files.clear();
        for (const file of payload["files"] ?? []) {
          files.set(file.path, Buffer.from(file.base64, "base64").toString("utf8"));
        }
        return reply(200, { ok: true });
      }
      if (req.path === "/turn/collect") {
        const wanted: string[] | undefined = payload["paths"];
        const out = [...files.entries()]
          .filter(([path]) => (wanted === undefined ? path.startsWith("/user/") : wanted.includes(path)))
          .map(([path, text]) => ({ path, base64: Buffer.from(text).toString("base64") }));
        return reply(200, { files: out });
      }
      if (req.path === "/turn/start") {
        done = false;
        running = script({
          callTool: (name, args) => new Promise((resolve) => {
            const id = `ask_${answers.size}`;
            ask = { id, name, args };
            answers.set(id, resolve);
          }),
          emit: (event) => events.push(event),
          write: (path, text) => files.set(path, text),
          read: (path) => files.get(path),
          ...(payload["resume"] === undefined ? {} : { resume: String(payload["resume"]) }),
        }).catch(() => { box.destroyed = true; }).finally(() => { done = true; });
        return reply(202, { turnId: "turn_1" });
      }
      if (req.path.endsWith("/poll")) {
        // Let the scripted turn make progress before answering, exactly as a
        // real box's held-open poll does.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const cursor: number = payload["cursor"] ?? 0;
        const fresh = events.slice(cursor);
        return reply(200, {
          events: fresh,
          cursor: cursor + fresh.length,
          ...(ask === undefined ? {} : { ask }),
          done: done && ask === undefined,
        });
      }
      if (req.path.endsWith("/answer")) {
        const resolve = answers.get(payload["id"]);
        if (ask?.id === payload["id"]) ask = undefined;
        answers.delete(payload["id"]);
        resolve?.(payload["result"]);
        await Promise.resolve();
        return reply(200, { ok: true });
      }
      if (req.path.endsWith("/abort")) { await running?.catch(() => undefined); return reply(200, { ok: true }); }
      return reply(404, { error: req.path });
    },
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
  messages?: Array<{ id: string; text: string }>;
} = {}): TurnDouble {
  const workspace = testWorkspace(input.files ?? {});
  const calls: Array<{ name: string; args: Json }> = [];
  const state = createTurnState(input.state);
  const messages = (input.messages ?? [{ id: input.thread ?? `m_${(threadSeq += 1)}`, text: "make me a dashboard" }])
    .map((m) => userMessage(m.id, m.text));
  const turn = {
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
  test("the four v1 knobs are declared and nothing else is", () => {
    const shape = (claudeCode().optionsSchema as never as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["effort", "machine", "maxTurns", "model"]);
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

  test("the tool listing the box sees is the CURATED one, with its schemas", async () => {
    let projected: unknown;
    const sandbox = fakeSandbox(async () => undefined);
    const { turn } = makeTurn();
    // Intercept what the driver sends to /turn/start.
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => {
      const box = await original(spec);
      const request = box.request.bind(box);
      box.request = async (req) => {
        if (req.path === "/turn/start" && req.body !== undefined) {
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

  test("killing the sandbox mid-turn leaves the store untouched, and the next turn recovers", async () => {
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/apps/app_1/app.vendo", "<App>half</App>");
      // The provider's dead-machine signal, mid-turn.
      throw new VendoError("not-found", "machine is gone");
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

  test("one machine per session: a second turn on the same thread reuses it", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "session", sessionId: "sess_1" }); });
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_reuse" }).turn);
    await drain(harness, makeTurn({ thread: "thr_reuse", state: JSON.stringify({ sessionId: "sess_1" }) }).turn);
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("a second turn resumes the native session rather than re-seeding", async () => {
    let resumedWith: string | undefined;
    const sandbox = fakeSandbox(async (box) => {
      resumedWith = box.resume;
      box.emit({ type: "session", sessionId: "sess_1" });
    });
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_resume" }).turn);
    await drain(harness, makeTurn({ thread: "thr_resume", state: JSON.stringify({ sessionId: "sess_1" }) }).turn);
    expect(resumedWith).toBe("sess_1");
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
