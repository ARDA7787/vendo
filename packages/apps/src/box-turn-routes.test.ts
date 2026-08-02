import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// The box door is plain JS shipped into the machine image; the tests drive the
// real module, with only the SDK session injected.
import { createSessionRoutes } from "../box/turn-routes.mjs";

const TOKEN = "bxt_test";
const roots: string[] = [];

const newRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-session-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const b64 = (text: string): string => Buffer.from(text).toString("base64");
const auth = { "x-vendo-box-token": TOKEN };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Routes = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * A session double. The real `createClaudeSession` opens ONE query and answers
 * each pushed message; this stands in for it by running `body` per `send()`, so
 * the door's own halves — the parked ask, the poll cursor, the message registry —
 * are the only things under test.
 */
const scripted = (body: (input: Any, prompt: string) => Promise<void>) => {
  const opens: Any[] = [];
  const factory = (input: Any) => {
    opens.push(input);
    return {
      async send(prompt: string) { await body(input, prompt); },
      async interrupt() { input.__interrupted = true; },
      async end() { input.__ended = true; },
    };
  };
  return { factory, opens };
};

const routes = (root: string, body?: (input: Any, prompt: string) => Promise<void>): Routes => {
  const session = body === undefined ? undefined : scripted(body);
  const door = createSessionRoutes({
    root,
    token: TOKEN,
    env: {},
    ...(session === undefined ? {} : { openSession: session.factory }),
  }) as Routes;
  door.__opens = session?.opens ?? [];
  return door;
};

/** Post one message and return its id. */
const send = async (door: Routes, prompt: string, extra: Record<string, unknown> = {}) => {
  const started = await door.handle("POST", "/session/message", auth, { prompt, ...extra });
  return started;
};

describe("the box session door refuses anything without the machine token", () => {
  test("every /session route is closed to a caller with no token", async () => {
    const door = routes(newRoot());
    const answer = await door.handle("POST", "/session/collect", {}, {});
    expect(answer.status).toBe(401);
  });

  test("a machine with no token yet is claimed by the first hello, and closed after", async () => {
    const door = createSessionRoutes({ root: newRoot(), token: "", env: {} }) as Routes;
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(401);
    expect((await door.handle("POST", "/session/hello", {}, { token: TOKEN })).status).toBe(200);
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(200);
    // Trust on FIRST use: a second, unauthenticated hello cannot steal the box.
    expect((await door.handle("POST", "/session/hello", {}, { token: "attacker" })).status).toBe(401);
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(200);
  });

  test("there is no token ROTATION any more — a claimed box keeps the one token it was given", async () => {
    // The rotation protocol existed for ONE reason: a snapshot restored a
    // supervisor's memory, so a woken box still demanded the token it slept with
    // while the host minted a fresh one per acquire. A conversation box is never
    // snapshotted and never woken — it is destroyed — so rotation has no case
    // left to serve, and the simpler rule is the safer one.
    const door = createSessionRoutes({ root: newRoot(), token: TOKEN, env: {} }) as Routes;
    // The holder re-presenting its own token is the liveness probe, and it is
    // idempotent rather than a rotation.
    expect((await door.handle("POST", "/session/hello", auth, { token: TOKEN })).status).toBe(200);
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(200);
    // Nobody else may claim or change it.
    expect((await door.handle("POST", "/session/hello", { "x-vendo-box-token": "fresh" }, { token: "fresh" })).status)
      .toBe(401);
    expect((await door.handle("POST", "/session/collect", { "x-vendo-box-token": "fresh" }, {})).status).toBe(401);
  });

  test("hello carries the conversation's credential to the SDK, and nothing else does", async () => {
    let saw: Record<string, string> | undefined;
    const session = scripted(async () => undefined);
    const door = createSessionRoutes({
      root: newRoot(), token: "", env: {},
      openSession: (input: Any) => {
        saw = input.env;
        return session.factory(input);
      },
    }) as Routes;
    await door.handle("POST", "/session/hello", {}, { token: TOKEN, env: { ANTHROPIC_API_KEY: "k", NOPE: 7 } });
    const { body } = await send(door, "go");
    await door.messagePromise(body.messageId);
    expect(saw).toEqual({ ANTHROPIC_API_KEY: "k" });
  });
});

describe("materialize + collect", () => {
  test("files land under the root in the frozen layout, and read back by workspace path", async () => {
    const root = newRoot();
    const door = routes(root);
    await door.handle("POST", "/session/workspace", auth, {
      reset: true,
      files: [
        { path: "/user/apps/app_1/app.vendo", base64: b64("<App/>") },
        { path: "/host/skills/refund/SKILL.md", base64: b64("# refund"), readOnly: true },
      ],
    });
    expect(readFileSync(path.join(root, "user/apps/app_1/app.vendo"), "utf8")).toBe("<App/>");

    const collected = await door.handle("POST", "/session/collect", auth, {});
    // Only the writable mount comes back: /host is reference, never a diff.
    expect(collected.body.files.map((f: { path: string }) => f.path)).toEqual([
      "/user/apps/app_1/app.vendo",
    ]);
  });

  test("the /host mount lands where the SDK looks for a local plugin's skills", async () => {
    // The plugin root the harness passes is `<root>/host`, and the SDK reads
    // `<pluginPath>/skills/<name>/SKILL.md`. `hostSkillFiles` already writes
    // exactly that path, so the mount IS the plugin — no copy, no translation.
    const root = newRoot();
    const door = routes(root);
    await door.handle("POST", "/session/workspace", auth, {
      reset: true,
      files: [{ path: "/host/skills/refund/SKILL.md", base64: b64("# refund"), readOnly: true }],
    });
    expect(readFileSync(path.join(root, "host", "skills/refund/SKILL.md"), "utf8")).toBe("# refund");
  });

  test("a narrowed collect answers only the asked paths, and skips ones not written yet", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, "user/apps/app_1"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_1/plan.vendo"), "plan");
    const answer = await door.handle("POST", "/session/collect", auth, {
      paths: ["/user/apps/app_1/plan.vendo", "/user/apps/app_1/app.vendo"],
    });
    expect(answer.body.files).toEqual([
      { path: "/user/apps/app_1/plan.vendo", base64: b64("plan") },
    ]);
  });

  test("D5 · a `*` segment asks by SHAPE, which is how a file invented mid-turn is collectable", async () => {
    const root = newRoot();
    const door = routes(root);
    // The appId the host could NOT have named when the conversation started.
    mkdirSync(path.join(root, "user/apps/app_invented"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_invented/plan.vendo"), "plan");
    // Deliberate near-misses: `*` is ONE segment, and the hot names are exact.
    mkdirSync(path.join(root, "user/apps/app_invented/nested"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_invented/nested/plan.vendo"), "deeper");
    writeFileSync(path.join(root, "user/apps/app_invented/notes.md"), "notes");
    const answer = await door.handle("POST", "/session/collect", auth, {
      paths: ["/user/apps/*/plan.vendo"],
    });
    expect(answer.body.files).toEqual([
      { path: "/user/apps/app_invented/plan.vendo", base64: b64("plan") },
    ]);
  });

  test("D5 · a walking collect answers about /user only, `*` included", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, "host/skills/refund"), { recursive: true });
    writeFileSync(path.join(root, "host/skills/refund/SKILL.md"), "# refund");
    const answer = await door.handle("POST", "/session/collect", auth, { paths: ["/host/*/*"] });
    expect(answer.body.files).toEqual([]);
  });

  test("the SDK's own session store is machine state, never the user's files", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, ".claude/projects"), { recursive: true });
    writeFileSync(path.join(root, ".claude/projects/sess.jsonl"), "{}");
    const answer = await door.handle("POST", "/session/collect", auth, {});
    expect(answer.body.files).toEqual([]);
  });
});

describe("one live session, many messages", () => {
  test("a second message reuses the SAME session — it is never reopened", async () => {
    const root = newRoot();
    const prompts: string[] = [];
    const door = routes(root, async (_input, prompt) => { prompts.push(prompt); });

    const first = await send(door, "what do I owe?", { tools: [{ name: "a" }] });
    await door.messagePromise(first.body.messageId);
    const second = await send(door, "and the oldest?", { tools: [{ name: "a" }] });
    await door.messagePromise(second.body.messageId);

    expect(prompts).toEqual(["what do I owe?", "and the oldest?"]);
    // ONE open: that is the whole cc-native change.
    expect(door.__opens).toHaveLength(1);
  });

  test("a CHANGED tool listing reopens the session, resuming its own id so nothing is forgotten", async () => {
    const root = newRoot();
    const door = routes(root, async (input) => {
      input.emit({ type: "session", sessionId: "sess_box" });
    });

    const first = await send(door, "one", { tools: [{ name: "a" }] });
    await door.messagePromise(first.body.messageId);
    // `find_tools` equipped something new, so the in-process MCP server has to be
    // rebuilt — an SDK MCP server's tool set is fixed at session open.
    const second = await send(door, "two", { tools: [{ name: "a" }, { name: "b" }] });
    await door.messagePromise(second.body.messageId);

    expect(door.__opens).toHaveLength(2);
    // The reopen carries the session id forward, so a new tool costs a restart
    // and never a memory.
    expect(door.__opens[1].resume).toBe("sess_box");
    expect(door.__opens[0].__ended).toBe(true);
  });

  test("the native PostToolUse hook comes home as a `wrote` event, which is what replaced polling", async () => {
    const root = newRoot();
    const door = routes(root, async (input) => {
      input.onFileWritten("/workspace/user/apps/app_1/app.vendo");
      input.onFileWritten(undefined);
    });
    const { body } = await send(door, "build it");
    await door.messagePromise(body.messageId);
    const polled = await door.handle("POST", `/session/${body.messageId}/poll`, auth, { cursor: 0, waitMs: 100 });
    expect(polled.body.events).toEqual([
      { type: "wrote", path: "/workspace/user/apps/app_1/app.vendo" },
      // A `Bash` write names no path; the host answers it with a collect-by-shape.
      { type: "wrote" },
    ]);
  });

  test("interrupt stops the turn and leaves the session alive", async () => {
    const root = newRoot();
    const door = routes(root, async () => undefined);
    const { body } = await send(door, "go");
    await door.messagePromise(body.messageId);
    expect((await door.handle("POST", `/session/${body.messageId}/interrupt`, auth, {})).status).toBe(200);
    expect(door.__opens[0].__interrupted).toBe(true);
    // The session was never ended — only the turn was cut short.
    expect(door.__opens[0].__ended).toBeUndefined();
  });
});

describe("the inverted bridge — the host executes, the box never does", () => {
  test("a projected call is parked, handed out on the next poll, and answered", async () => {
    const root = newRoot();
    let seen: { name: string; args: unknown } | undefined;
    let answered: unknown;
    const door = routes(root, async (input) => {
      input.emit({ type: "text", delta: "checking" });
      answered = await input.callTool("maple_invoices_list", { limit: 2 });
      input.emit({ type: "text", delta: "done" });
    });

    const started = await send(door, "hi");
    expect(started.status).toBe(202);
    const messageId = started.body.messageId as string;

    let cursor = 0;
    const first = await door.handle("POST", `/session/${messageId}/poll`, auth, { cursor, waitMs: 500 });
    cursor = first.body.cursor;
    expect(first.body.events).toEqual([{ type: "text", delta: "checking" }]);
    expect(first.body.asks).toHaveLength(1);
    expect(first.body.asks[0]).toMatchObject({ name: "maple_invoices_list", args: { limit: 2 } });
    seen = first.body.asks[0];

    await door.handle("POST", `/session/${messageId}/answer`, auth, {
      id: (seen as { id: string }).id,
      result: { status: "ok", output: { invoices: [] } },
    });
    expect(answered).toEqual({ status: "ok", output: { invoices: [] } });

    await door.messagePromise(messageId);
    const last = await door.handle("POST", `/session/${messageId}/poll`, auth, { cursor, waitMs: 100 });
    expect(last.body.events).toEqual([{ type: "text", delta: "done" }]);
    expect(last.body.done).toBe(true);
  });

  test("a denial from the host reaches the model verbatim, as a denial", async () => {
    const root = newRoot();
    let got: unknown;
    const door = routes(root, async (input) => {
      got = await input.callTool("maple_invoices_pay", { id: "inv_1" });
    });
    const { body } = await send(door, "pay it");
    const polled = await door.handle("POST", `/session/${body.messageId}/poll`, auth, { cursor: 0, waitMs: 500 });
    await door.handle("POST", `/session/${body.messageId}/answer`, auth, {
      id: polled.body.asks[0].id,
      result: { status: "denied", reason: "You'll need to approve that." },
    });
    await door.messagePromise(body.messageId);
    expect(got).toEqual({ status: "denied", reason: "You'll need to approve that." });
  });

  test("anything the host sends is DATA — an unknown status degrades to a narratable error", async () => {
    const root = newRoot();
    let got: unknown;
    const door = routes(root, async (input) => { got = await input.callTool("x", {}); });
    const { body } = await send(door, "go");
    const polled = await door.handle("POST", `/session/${body.messageId}/poll`, auth, { cursor: 0, waitMs: 500 });
    await door.handle("POST", `/session/${body.messageId}/answer`, auth, {
      id: polled.body.asks[0].id,
      result: { status: "approve-everything", output: "trust me" },
    });
    await door.messagePromise(body.messageId);
    expect(got).toMatchObject({ status: "error" });
  });

  test("M2 · TWO concurrent projected calls are both handed out — neither starves", async () => {
    const root = newRoot();
    const answers: unknown[] = [];
    const door = routes(root, async (input) => {
      // The model emitted two tool_use blocks in one assistant turn; the SDK
      // dispatches both MCP handlers before either resolves.
      answers.push(...await Promise.all([
        input.callTool("maple_invoices_list", { status: "open" }),
        input.callTool("maple_invoices_list", { status: "paid" }),
      ]));
    });
    const { body } = await send(door, "both");
    const polled = await door.handle("POST", `/session/${body.messageId}/poll`, auth, { cursor: 0, waitMs: 500 });
    expect(polled.body.asks).toHaveLength(2);
    for (const ask of polled.body.asks) {
      await door.handle("POST", `/session/${body.messageId}/answer`, auth, {
        id: ask.id,
        result: { status: "ok", output: ask.args },
      });
    }
    await door.messagePromise(body.messageId);
    expect(answers).toHaveLength(2);
    expect(answers.map((a: Any) => a.output.status).sort()).toEqual(["open", "paid"]);
  });

  test("M2 · an ask is handed out ONCE, so the host can never execute one intent twice", async () => {
    const root = newRoot();
    const door = routes(root, async (input) => { await input.callTool("x", {}); });
    const { body } = await send(door, "go");
    const first = await door.handle("POST", `/session/${body.messageId}/poll`, auth, { cursor: 0, waitMs: 300 });
    expect(first.body.asks).toHaveLength(1);
    // A second poll before answering must NOT re-offer it.
    const second = await door.handle("POST", `/session/${body.messageId}/poll`, auth, {
      cursor: first.body.cursor, waitMs: 50,
    });
    expect(second.body.asks ?? []).toHaveLength(0);
    await door.handle("POST", `/session/${body.messageId}/answer`, auth, {
      id: first.body.asks[0].id, result: { status: "ok", output: 1 },
    });
    await door.messagePromise(body.messageId);
  });

  test("a message that fails still ends, with a consumer-voice error and no dangling ask", async () => {
    const root = newRoot();
    const door = routes(root, async () => { throw new Error("ANTHROPIC_API_KEY missing"); });
    const { body } = await send(door, "go");
    await door.messagePromise(body.messageId);
    const polled = await door.handle("POST", `/session/${body.messageId}/poll`, auth, { cursor: 0, waitMs: 100 });
    expect(polled.body.done).toBe(true);
    expect(polled.body.asks ?? []).toHaveLength(0);
    expect(JSON.stringify(polled.body.events)).not.toContain("ANTHROPIC_API_KEY");
    expect(polled.body.events[0]).toMatchObject({ type: "error" });
  });

  test("one message at a time per box", async () => {
    const root = newRoot();
    const door = routes(root, async (input) => { await input.callTool("x", {}); });
    await send(door, "one");
    expect((await send(door, "two")).status).toBe(409);
  });

  test("a tool call arriving between messages is refused rather than misattributed", async () => {
    const root = newRoot();
    let escaped: unknown;
    const door = routes(root, async () => undefined);
    const { body } = await send(door, "go");
    await door.messagePromise(body.messageId);
    // The live session outlives the message, so a late handler CAN still fire.
    // It must not land in the next message's ask queue.
    escaped = await door.__opens[0].callTool("maple_invoices_pay", { id: "inv_1" });
    expect(escaped).toMatchObject({ status: "error" });
  });
});
