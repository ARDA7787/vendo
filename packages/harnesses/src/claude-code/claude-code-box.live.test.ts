/**
 * The SANDBOX leg of the live proof: a real e2b machine, the real box image,
 * the real inverted bridge, the real Agent SDK inside the box.
 *
 * Gated on `E2B_API_KEY` + `ANTHROPIC_API_KEY` + `VENDO_BOX_TEMPLATE` (the
 * template `packages/apps/box/build-template.mjs` bakes — it carries the turn
 * door and `claude-turn.mjs`). Skipped otherwise, like every `.live.test.ts`.
 */
import { e2bSandbox } from "@vendoai/apps/e2b";
import type { Json, ToolResult, Turn } from "@vendoai/core";
import { afterAll, describe, expect, test } from "vitest";
import { createTurnState } from "../harness-state.js";
import { testWorkspace, unusedModels, userMessage } from "../test-doubles.test-util.js";
import { claudeCode } from "./index.js";
import { disposeSessionMachines, type SandboxAdapterLike } from "./box.js";

const ready = process.env["E2B_API_KEY"] !== undefined
  && process.env["ANTHROPIC_API_KEY"] !== undefined
  && process.env["VENDO_BOX_TEMPLATE"] !== undefined;
const live = ready ? describe : describe.skip;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

function harnessed(input: {
  say: string;
  files?: Record<string, string>;
  tools?: Array<{ name: string; title: string; description: string; inputSchema?: Json }>;
  answer?: (name: string, args: Json) => ToolResult;
  thread: string;
  state?: string;
}) {
  const workspace = testWorkspace(input.files ?? {});
  const calls: Array<{ name: string; args: Json }> = [];
  const state = createTurnState(input.state);
  const turn = {
    messages: [userMessage(input.thread, input.say)],
    tools: {
      list: async () => (input.tools ?? []).map((tool) => ({ ...tool, risk: "read" as const })),
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
    signal: AbortSignal.timeout(540_000),
    interactive: true,
    system: "You are the assistant inside Maple, a small business banking product.",
  } as unknown as Turn<never>;
  return { turn, workspace, calls, state };
}

live("claudeCode() — live, in a real e2b box", () => {
  afterAll(async () => { await disposeSessionMachines(); });

  const sandbox = (): SandboxAdapterLike => e2bSandbox({
    apiKey: process.env["E2B_API_KEY"]!,
    timeoutMs: 10 * 60_000,
  }) as unknown as SandboxAdapterLike;

  test("E3 · the box's real bash edits the app, and the diff lands in OUR store", async () => {
    const h = harnessed({
      thread: "m_box_edit",
      say: "The dashboard heading says 'Invoices'. Change it to say 'Bills' and nothing else.",
      files: {
        "/user/apps/app_box/app.vendo": '<App name="Money">\n  <Heading text="Invoices" />\n</App>\n',
        "/host/skills/refund/SKILL.md": "# refund\nHow refunds work here.\n",
      },
    });
    let text = "";
    for await (const event of claudeCode({ sandbox: sandbox(), model: MODEL, maxTurns: 14 })
      .run(h.turn as never)) {
      if (event.type === "text") text += event.delta;
      if (event.type === "error") text += `\n[error] ${event.message}`;
    }
    const after = await h.workspace.readFile("/user/apps/app_box/app.vendo");
    console.log("[live box edit]", JSON.stringify({ text, after, commits: h.workspace.commits }));
    expect(after).toContain("Bills");
    expect(text).not.toContain("[error]");
    // /host came along read-only and never came back.
    expect(await h.workspace.readFile("/host/skills/refund/SKILL.md")).toContain("How refunds work here.");
  }, 600_000);

  test("§1.3 · the pooled machine keeps its native session across turns", async () => {
    const adapter = sandbox();
    const first = harnessed({ thread: "m_box_session", say: "Remember the number 8823. Just say ok." });
    for await (const _ of claudeCode({ sandbox: adapter, model: MODEL, maxTurns: 6 }).run(first.turn as never)) {
      // drain
    }
    const carried = first.state.pending().value;
    expect(JSON.parse(carried!).sessionId).toMatch(/.+/);

    const second = harnessed({
      thread: "m_box_session",
      say: "What number did I ask you to remember? Reply with digits only.",
      state: carried!,
    });
    let text = "";
    for await (const event of claudeCode({ sandbox: adapter, model: MODEL, maxTurns: 6 })
      .run(second.turn as never)) {
      if (event.type === "text") text += event.delta;
      if (event.type === "error") text += `\n[error] ${event.message}`;
    }
    console.log("[live box session]", JSON.stringify({ carried, text }));
    expect(text).toContain("8823");
  }, 600_000);

  test("E7 · a guarded call executes HOST-side, and the box env holds no credential but inference", async () => {
    process.env["VENDO_LANE_E_BOX_CANARY"] = "never-in-a-box";
    const h = harnessed({
      thread: "m_box_tools",
      say: "First tell me how many invoices are outstanding. Then write the full output of "
        + "`env | sort` to user/files/env.txt. Then say done.",
      tools: [{
        name: "maple_invoices_list",
        title: "List invoices",
        description: "List the signed-in user's invoices.",
        inputSchema: { type: "object", properties: {} } as never,
      }],
      answer: () => ({ status: "ok", output: [{ id: "inv_1" }, { id: "inv_2" }] }),
    });
    let text = "";
    try {
      for await (const event of claudeCode({ sandbox: sandbox(), model: MODEL, maxTurns: 16 })
        .run(h.turn as never)) {
        if (event.type === "text") text += event.delta;
        if (event.type === "error") text += `\n[error] ${event.message}`;
      }
    } finally {
      delete process.env["VENDO_LANE_E_BOX_CANARY"];
    }
    const dump = await h.workspace.readFile("/user/files/env.txt");
    console.log("[live box tools]", JSON.stringify({ text, calls: h.calls }));
    console.log("[live box env]", dump.split("\n").map((line) => line.split("=")[0]).filter(Boolean).join(","));
    expect(h.calls.map((call) => call.name)).toContain("maple_invoices_list");
    expect(dump).not.toContain("never-in-a-box");
    expect(dump).not.toContain(process.env["E2B_API_KEY"]);
    expect(dump).toContain("ANTHROPIC_API_KEY");
  }, 600_000);
});
