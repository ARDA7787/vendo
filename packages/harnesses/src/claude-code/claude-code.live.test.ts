/**
 * The live proof for `claudeCode()` — a REAL Claude Agent SDK, real bash hands
 * over a real materialized workspace, our real guard seam.
 *
 * Gated on `ANTHROPIC_API_KEY`, like every other `.live.test.ts` in the repo:
 * skipped without it, so CI and a keyless clone stay green.
 *
 * `machine: "local"` on purpose. The sandbox path adds an e2b machine and a
 * control-port hop and changes NOTHING above the `TurnMachine` port — the
 * projection, the permission hook, the diff sync-back and `turn.state` are the
 * same code either way, and this is the leg that can be proven without a
 * provider account or a template bake.
 */
import type { Json, ToolResult, Turn } from "@vendoai/core";
import { describe, expect, test } from "vitest";
import { createTurnState } from "../harness-state.js";
import { testWorkspace, unusedModels, userMessage } from "../test-doubles.test-util.js";
import { claudeCode } from "./index.js";

const live = process.env["ANTHROPIC_API_KEY"] === undefined ? describe.skip : describe;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

interface Harnessed {
  turn: Turn<never>;
  workspace: ReturnType<typeof testWorkspace>;
  calls: Array<{ name: string; args: Json }>;
  state: ReturnType<typeof createTurnState>;
}

function harnessed(input: {
  say: string;
  files?: Record<string, string>;
  tools?: Array<{ name: string; title: string; description: string; inputSchema?: Json }>;
  answer?: (name: string, args: Json) => ToolResult;
  state?: string;
  thread?: string;
}): Harnessed {
  const workspace = testWorkspace(input.files ?? {});
  const calls: Array<{ name: string; args: Json }> = [];
  const state = createTurnState(input.state);
  const turn = {
    messages: [userMessage(input.thread ?? `m_${Math.random().toString(36).slice(2)}`, input.say)],
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
    signal: AbortSignal.timeout(240_000),
    interactive: true,
    system: "You are the assistant inside Maple, a small business banking product.",
  } as unknown as Turn<never>;
  return { turn, workspace, calls, state };
}

async function say(h: Harnessed, options: Record<string, unknown> = {}): Promise<string> {
  const harness = claudeCode({ machine: "local", model: MODEL, maxTurns: 12, ...options });
  let text = "";
  for await (const event of harness.run(h.turn as never)) {
    if (event.type === "text") text += event.delta;
    if (event.type === "error") text += `\n[error] ${event.message}`;
  }
  return text;
}

live("claudeCode() — live, machine:\"local\"", () => {
  test("E1 · a normal ask reaches the projected tool, and the tool executes HOST-side", async () => {
    const h = harnessed({
      say: "How many invoices are outstanding? Just tell me the number.",
      tools: [{
        name: "maple_invoices_list",
        title: "List invoices",
        description: "List the signed-in user's invoices. Returns every invoice with its status.",
        inputSchema: { type: "object", properties: { status: { type: "string" } } } as never,
      }],
      answer: () => ({
        status: "ok",
        output: [{ id: "inv_1", status: "outstanding" }, { id: "inv_2", status: "outstanding" }],
      }),
    });
    const reply = await say(h);
    console.log("[live E1 normal]", JSON.stringify({ reply, calls: h.calls }));
    expect(h.calls.map((call) => call.name)).toContain("maple_invoices_list");
    expect(reply).toMatch(/2|two/i);
  }, 300_000);

  test("E1 · edit-in-place: the box's real bash edits the app, and the DIFF lands in the store", async () => {
    const h = harnessed({
      say: "The dashboard heading says 'Invoices'. Change it to say 'Bills' and nothing else.",
      files: {
        "/user/apps/app_live/app.vendo": '<App name="Money">\n  <Heading text="Invoices" />\n</App>\n',
      },
    });
    const reply = await say(h);
    const after = await h.workspace.readFile("/user/apps/app_live/app.vendo");
    console.log("[live E1 edit]", JSON.stringify({ reply, after, commits: h.workspace.commits }));
    expect(after).toContain("Bills");
    expect(after).not.toContain("Invoices");
    // Diff-based, never wholesale: exactly one file changed.
    expect(h.workspace.commits.flatMap((commit) => commit.changed)).toEqual([
      "/user/apps/app_live/app.vendo",
    ]);
  }, 300_000);

  test("E1 · a guard DENIAL comes back through the native permission hook and is narrated", async () => {
    const h = harnessed({
      say: "Please pay invoice inv_1 now.",
      tools: [{
        name: "maple_invoices_pay",
        title: "Pay an invoice",
        description: "Pay one of the user's invoices.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as never,
      }],
      answer: () => ({
        status: "denied",
        reason: "That payment needs the person's approval before it can go through.",
      }),
    });
    const reply = await say(h);
    console.log("[live E1 denial]", JSON.stringify({ reply, calls: h.calls }));
    expect(h.calls.map((call) => call.name)).toContain("maple_invoices_pay");
    // Narrated, not crashed: the model explains and stops.
    expect(reply.toLowerCase()).toMatch(/approv|permission|confirm/);
    expect(reply).not.toContain("[error]");
  }, 300_000);

  test("E1 · an impossible ask is refused honestly, with no invented tool", async () => {
    const h = harnessed({
      say: "Book me a flight to Tokyo for tomorrow morning.",
      tools: [{
        name: "maple_invoices_list",
        title: "List invoices",
        description: "List the signed-in user's invoices.",
      }],
    });
    const reply = await say(h);
    console.log("[live E1 impossible]", JSON.stringify({ reply, calls: h.calls }));
    expect(h.calls).toEqual([]);
    expect(reply.toLowerCase()).toMatch(/can'?t|cannot|not able|don'?t have|unable/);
  }, 300_000);

  test("§1.3 · turn.state carries the native session, and the next turn RESUMES it", async () => {
    const first = harnessed({ say: "Remember the number 4127. Just say ok.", thread: "m_live_session" });
    await say(first);
    const carried = first.state.pending().value;
    console.log("[live session]", JSON.stringify({ carried }));
    expect(carried).toBeDefined();
    expect(JSON.parse(carried!).sessionId).toMatch(/.+/);

    const second = harnessed({
      say: "What number did I ask you to remember? Reply with digits only.",
      thread: "m_live_session",
      state: carried!,
    });
    const reply = await say(second);
    console.log("[live session resume]", JSON.stringify({ reply }));
    expect(reply).toContain("4127");
  }, 420_000);

  test("E7 · the SDK subprocess gets the inference credential and NOTHING else", async () => {
    process.env["VENDO_LANE_E_CANARY"] = "leaked-secret-value";
    try {
      const h = harnessed({
        say: "Run `env | sort` and write its full output to user/scratch/env.txt, then say done.",
      });
      await say(h);
      // scratch never syncs, so read it off the machine the only honest way: the
      // agent also writes a copy the sync-back WILL carry.
      const h2 = harnessed({
        say: "Run `env | sort` and write its full output to user/files/env.txt, then say done.",
      });
      await say(h2);
      const dump = await h2.workspace.readFile("/user/files/env.txt");
      console.log("[live E7] env var names in the subprocess:",
        dump.split("\n").map((line) => line.split("=")[0]).filter(Boolean).join(","));
      expect(dump).not.toContain("leaked-secret-value");
      expect(dump).not.toContain("VENDO_LANE_E_CANARY");
      expect(dump).toContain("ANTHROPIC_API_KEY");
    } finally {
      delete process.env["VENDO_LANE_E_CANARY"];
    }
  }, 420_000);
});
