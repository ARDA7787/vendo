import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// The box door is plain JS shipped into the machine image; the tests drive the
// real module, with only the SDK loop injected.
import { createTurnRoutes } from "../box/turn-routes.mjs";

const TOKEN = "bxt_test";
const roots: string[] = [];

const newRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-turn-"));
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

const routes = (root: string, runTurn?: unknown): Routes =>
  createTurnRoutes({ root, token: TOKEN, env: {}, ...(runTurn === undefined ? {} : { runTurn }) }) as Routes;

describe("the box turn door refuses anything without the machine token", () => {
  test("every /turn route is closed to a caller with no token", async () => {
    const door = routes(newRoot());
    const answer = await door.handle("POST", "/turn/collect", {}, {});
    expect(answer.status).toBe(401);
  });

  test("a machine with no token yet is claimed by the first hello, and closed after", async () => {
    const door = createTurnRoutes({ root: newRoot(), token: "", env: {} }) as Routes;
    expect((await door.handle("POST", "/turn/collect", auth, {})).status).toBe(401);
    expect((await door.handle("POST", "/turn/hello", {}, { token: TOKEN })).status).toBe(200);
    expect((await door.handle("POST", "/turn/collect", auth, {})).status).toBe(200);
    // Trust on FIRST use: a second, unauthenticated hello cannot steal the box.
    expect((await door.handle("POST", "/turn/hello", {}, { token: "attacker" })).status).toBe(401);
    expect((await door.handle("POST", "/turn/collect", auth, {})).status).toBe(200);
  });

  test("B1 · the token holder may ROTATE it — which is what lets a woken box be used", async () => {
    const door = createTurnRoutes({ root: newRoot(), token: TOKEN, env: {} }) as Routes;
    // A woken machine restored its memory, so it still demands the OLD token.
    // Presenting the NEW one alone is exactly the 401 that locked every idle
    // thread out of its next message.
    expect((await door.handle("POST", "/turn/hello", { "x-vendo-box-token": "fresh" }, { token: "fresh" })).status)
      .toBe(401);
    // Presenting the OLD one rotates to the new.
    expect((await door.handle("POST", "/turn/hello", auth, { token: "fresh" })).status).toBe(200);
    expect((await door.handle("POST", "/turn/collect", { "x-vendo-box-token": "fresh" }, {})).status).toBe(200);
    // And the old token is dead the moment it has been spent.
    expect((await door.handle("POST", "/turn/collect", auth, {})).status).toBe(401);
    expect((await door.handle("POST", "/turn/hello", auth, { token: "attacker" })).status).toBe(401);
  });

  test("hello carries the turn's credential to the SDK, and nothing else does", async () => {
    let saw: Record<string, string> | undefined;
    const door = createTurnRoutes({
      root: newRoot(), token: "", env: {},
      runTurn: async (input: any) => { saw = input.env; },
    }) as Routes;
    await door.handle("POST", "/turn/hello", {}, { token: TOKEN, env: { ANTHROPIC_API_KEY: "k", NOPE: 7 } });
    const { body } = await door.handle("POST", "/turn/start", auth, { prompt: "go" });
    await door.turnPromise(body.turnId);
    expect(saw).toEqual({ ANTHROPIC_API_KEY: "k" });
  });
});

describe("materialize + collect", () => {
  test("files land under the root in the frozen layout, and read back by workspace path", async () => {
    const root = newRoot();
    const door = routes(root);
    await door.handle("POST", "/turn/workspace", auth, {
      reset: true,
      files: [
        { path: "/user/apps/app_1/app.vendo", base64: b64("<App/>") },
        { path: "/host/skills/refund/SKILL.md", base64: b64("# refund"), readOnly: true },
      ],
    });
    expect(readFileSync(path.join(root, "user/apps/app_1/app.vendo"), "utf8")).toBe("<App/>");

    const collected = await door.handle("POST", "/turn/collect", auth, {});
    // Only the writable mount comes back: /host is reference, never a diff.
    expect(collected.body.files.map((f: { path: string }) => f.path)).toEqual([
      "/user/apps/app_1/app.vendo",
    ]);
  });

  test("a narrowed collect answers only the asked paths, and skips ones not written yet", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, "user/apps/app_1"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_1/plan.vendo"), "plan");
    const answer = await door.handle("POST", "/turn/collect", auth, {
      paths: ["/user/apps/app_1/plan.vendo", "/user/apps/app_1/app.vendo"],
    });
    expect(answer.body.files).toEqual([
      { path: "/user/apps/app_1/plan.vendo", base64: b64("plan") },
    ]);
  });

  test("D5 · a `*` segment asks by SHAPE, which is how a file invented mid-turn is collectable", async () => {
    const root = newRoot();
    const door = routes(root);
    // The appId the host could NOT have named when the turn started.
    mkdirSync(path.join(root, "user/apps/app_invented"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_invented/plan.vendo"), "plan");
    // Deliberate near-misses: `*` is ONE segment, and the hot names are exact.
    mkdirSync(path.join(root, "user/apps/app_invented/nested"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_invented/nested/plan.vendo"), "deeper");
    writeFileSync(path.join(root, "user/apps/app_invented/notes.md"), "notes");
    const answer = await door.handle("POST", "/turn/collect", auth, {
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
    const answer = await door.handle("POST", "/turn/collect", auth, { paths: ["/host/*/*"] });
    expect(answer.body.files).toEqual([]);
  });

  test("the SDK's own session store is machine state, never the user's files", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, ".claude/projects"), { recursive: true });
    writeFileSync(path.join(root, ".claude/projects/sess.jsonl"), "{}");
    const answer = await door.handle("POST", "/turn/collect", auth, {});
    expect(answer.body.files).toEqual([]);
  });
});

describe("the inverted bridge — the host executes, the box never does", () => {
  test("a projected call is parked, handed out on the next poll, and answered", async () => {
    const root = newRoot();
    let seen: { name: string; args: unknown } | undefined;
    let answered: unknown;
    const door = routes(root, async (input: any) => {
      input.emit({ type: "text", delta: "checking" });
      answered = await input.callTool("maple_invoices_list", { limit: 2 });
      input.emit({ type: "text", delta: "done" });
    });

    const started = await door.handle("POST", "/turn/start", auth, { prompt: "hi" });
    expect(started.status).toBe(202);
    const turnId = started.body.turnId as string;

    let cursor = 0;
    const first = await door.handle("POST", `/turn/${turnId}/poll`, auth, { cursor, waitMs: 500 });
    cursor = first.body.cursor;
    expect(first.body.events).toEqual([{ type: "text", delta: "checking" }]);
    expect(first.body.asks).toHaveLength(1);
    expect(first.body.asks[0]).toMatchObject({ name: "maple_invoices_list", args: { limit: 2 } });
    seen = first.body.asks[0];

    await door.handle("POST", `/turn/${turnId}/answer`, auth, {
      id: (seen as { id: string }).id,
      result: { status: "ok", output: { invoices: [] } },
    });
    expect(answered).toEqual({ status: "ok", output: { invoices: [] } });

    await door.turnPromise(turnId);
    const last = await door.handle("POST", `/turn/${turnId}/poll`, auth, { cursor, waitMs: 100 });
    expect(last.body.events).toEqual([{ type: "text", delta: "done" }]);
    expect(last.body.done).toBe(true);
  });

  test("a denial from the host reaches the model verbatim, as a denial", async () => {
    const root = newRoot();
    let got: unknown;
    const door = routes(root, async (input: any) => {
      got = await input.callTool("maple_invoices_pay", { id: "inv_1" });
    });
    const { body } = await door.handle("POST", "/turn/start", auth, { prompt: "pay it" });
    const polled = await door.handle("POST", `/turn/${body.turnId}/poll`, auth, { cursor: 0, waitMs: 500 });
    await door.handle("POST", `/turn/${body.turnId}/answer`, auth, {
      id: polled.body.asks[0].id,
      result: { status: "denied", reason: "You'll need to approve that." },
    });
    await door.turnPromise(body.turnId);
    expect(got).toEqual({ status: "denied", reason: "You'll need to approve that." });
  });

  test("anything the host sends is DATA — an unknown status degrades to a narratable error", async () => {
    const root = newRoot();
    let got: unknown;
    const door = routes(root, async (input: any) => { got = await input.callTool("x", {}); });
    const { body } = await door.handle("POST", "/turn/start", auth, { prompt: "go" });
    const polled = await door.handle("POST", `/turn/${body.turnId}/poll`, auth, { cursor: 0, waitMs: 500 });
    await door.handle("POST", `/turn/${body.turnId}/answer`, auth, {
      id: polled.body.asks[0].id,
      result: { status: "approve-everything", output: "trust me" },
    });
    await door.turnPromise(body.turnId);
    expect(got).toMatchObject({ status: "error" });
  });

  test("M2 · TWO concurrent projected calls are both handed out — neither starves", async () => {
    const root = newRoot();
    const answers: unknown[] = [];
    const door = routes(root, async (input: any) => {
      // The model emitted two tool_use blocks in one assistant turn; the SDK
      // dispatches both MCP handlers before either resolves.
      answers.push(...await Promise.all([
        input.callTool("maple_invoices_list", { status: "open" }),
        input.callTool("maple_invoices_list", { status: "paid" }),
      ]));
    });
    const { body } = await door.handle("POST", "/turn/start", auth, { prompt: "both" });
    const polled = await door.handle("POST", `/turn/${body.turnId}/poll`, auth, { cursor: 0, waitMs: 500 });
    expect(polled.body.asks).toHaveLength(2);
    for (const ask of polled.body.asks) {
      await door.handle("POST", `/turn/${body.turnId}/answer`, auth, {
        id: ask.id,
        result: { status: "ok", output: ask.args },
      });
    }
    await door.turnPromise(body.turnId);
    expect(answers).toHaveLength(2);
    expect(answers.map((a: any) => a.output.status).sort()).toEqual(["open", "paid"]);
  });

  test("M2 · an ask is handed out ONCE, so the host can never execute one intent twice", async () => {
    const root = newRoot();
    const door = routes(root, async (input: any) => { await input.callTool("x", {}); });
    const { body } = await door.handle("POST", "/turn/start", auth, { prompt: "go" });
    const first = await door.handle("POST", `/turn/${body.turnId}/poll`, auth, { cursor: 0, waitMs: 300 });
    expect(first.body.asks).toHaveLength(1);
    // A second poll before answering must NOT re-offer it.
    const second = await door.handle("POST", `/turn/${body.turnId}/poll`, auth, {
      cursor: first.body.cursor, waitMs: 50,
    });
    expect(second.body.asks ?? []).toHaveLength(0);
    await door.handle("POST", `/turn/${body.turnId}/answer`, auth, {
      id: first.body.asks[0].id, result: { status: "ok", output: 1 },
    });
    await door.turnPromise(body.turnId);
  });

  test("a turn that fails still ends, with a consumer-voice error and no dangling ask", async () => {
    const root = newRoot();
    const door = routes(root, async () => { throw new Error("ANTHROPIC_API_KEY missing"); });
    const { body } = await door.handle("POST", "/turn/start", auth, { prompt: "go" });
    await door.turnPromise(body.turnId);
    const polled = await door.handle("POST", `/turn/${body.turnId}/poll`, auth, { cursor: 0, waitMs: 100 });
    expect(polled.body.done).toBe(true);
    expect(polled.body.asks ?? []).toHaveLength(0);
    expect(JSON.stringify(polled.body.events)).not.toContain("ANTHROPIC_API_KEY");
    expect(polled.body.events[0]).toMatchObject({ type: "error" });
  });

  test("one turn at a time per machine", async () => {
    const root = newRoot();
    const door = routes(root, async (input: any) => { await input.callTool("x", {}); });
    await door.handle("POST", "/turn/start", auth, { prompt: "one" });
    expect((await door.handle("POST", "/turn/start", auth, { prompt: "two" })).status).toBe(409);
  });
});
