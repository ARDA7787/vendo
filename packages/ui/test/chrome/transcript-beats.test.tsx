// @vitest-environment jsdom
/** Spec §1 + §8 D1 + §15 — the transcript shows the work.
 *
 *  Every tool call leaves a beat where it happened (reversing the old "the
 *  ribbon narrates, the transcript stays beat-free" pick), the settled turn
 *  folds its checklist into one reopenable row, the app-building call renders
 *  no beat because its card IS that step, and a FAILED turn grows no failure
 *  furniture at all — the ✕ stays in the record and the agent's prose carries
 *  the recovery. */
import type { Thread } from "@vendoai/core";
import type { UIMessage } from "ai";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { toolResultSummary } from "../../src/chrome/build-beat.js";
import { SplitViewContext, type SplitViewContextValue } from "../../src/chrome/split-view.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { createWireServer } from "../wire-server.js";

const NOW = "2026-08-03T12:00:00.000Z";

function threadWith(parts: Thread["messages"][number]["parts"]): Thread {
  return {
    id: "thr_beats",
    subject: "browser-user",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{ id: "msg_beats", role: "assistant", parts }],
  };
}

function threadClient(client: VendoClient, thread: Thread): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => (id === thread.id ? thread : client.threads.get(id)),
      list: async () => [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }],
    },
  };
}

const doneTool = (toolCallId: string, output: unknown, input: unknown = {}) => ({
  type: "dynamic-tool" as const,
  toolName: "host_list_transactions",
  toolCallId,
  state: "output-available" as const,
  input,
  output,
});

const failedTool = (toolCallId: string) => ({
  type: "dynamic-tool" as const,
  toolName: "host_list_transactions",
  toolCallId,
  state: "output-error" as const,
  input: {},
  errorText: "upstream 500",
});

describe("toolResultSummary (the beat's short result)", () => {
  it("names a count with the output's own key, singularizing one", () => {
    expect(toolResultSummary({ transactions: new Array(142).fill(0) })).toBe("142 transactions");
    expect(toolResultSummary({ transactions: [0] })).toBe("1 transaction");
    expect(toolResultSummary(new Array(3).fill(0))).toBe("3 results");
    expect(toolResultSummary({ count: 7 })).toBe("7 results");
  });

  it("stays silent when the output offers no honest count", () => {
    expect(toolResultSummary({ ok: true })).toBeUndefined();
    expect(toolResultSummary({ rows: [] })).toBeUndefined();
    expect(toolResultSummary("done")).toBeUndefined();
    expect(toolResultSummary(undefined)).toBeUndefined();
    // A tool's own prose is the TOOL's voice — never the product's line.
    expect(toolResultSummary({ message: "wrote row host_txn_9182" })).toBeUndefined();
  });
});

describe("the transcript's beats", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });
  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  async function mount(parts: Thread["messages"][number]["parts"]) {
    const thread = threadWith(parts);
    render(
      <VendoProvider client={threadClient(client, thread)}>
        <VendoThread threadId={thread.id} />
      </VendoProvider>,
    );
    await waitFor(() => expect(document.querySelector(".fl-turn-assistant")).toBeTruthy(), { timeout: 15_000 });
  }

  // C1 + C2 over a REAL streaming turn: the beat appears at its transcript
  // position while the call runs, ticks when it settles, and the closed turn
  // folds it into one row that reopens on click.
  it("beats a running call in-transcript, then folds the settled turn into one reopenable row", { timeout: 20_000 }, async () => {
    let release = () => undefined;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[tool-after-text] build it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    // The work is IN the conversation — a beat, not a ribbon above the composer.
    await waitFor(() => {
      const beat = document.querySelector("[data-vendo-tool='host_list_transactions']");
      expect(beat).toBeTruthy();
      expect(beat?.classList.contains("fl-beat")).toBe(true);
      expect(beat?.classList.contains("fl-beat-working")).toBe(true);
      expect(beat?.textContent).toContain("List transactions");
    });
    // C4 — the ribbon no longer narrates tool calls (the transcript owns it).
    expect(document.querySelector(".fl-ribbon[data-vendo-tool]")).toBeNull();
    // A live turn is never folded.
    expect(document.querySelector(".fl-beatsummary")).toBeNull();

    await act(async () => release());
    expect(await screen.findByText("All done.")).toBeTruthy();

    // C2 — settled: one row, with the measured wall time.
    const summary = await waitFor(() => {
      const row = document.querySelector(".fl-beatsummary");
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    expect(summary.textContent).toMatch(/^Did 1 thing · \d+\.\d+s$/);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-vendo-tool='host_list_transactions']")).toBeNull();

    // …and it reopens in place.
    fireEvent.click(summary);
    const beat = document.querySelector("[data-vendo-tool='host_list_transactions']");
    expect(beat?.classList.contains("fl-beat-done")).toBe(true);
    expect(document.querySelector(".fl-beatsummary")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("carries the short humanized result on a settled beat, never a raw slug", { timeout: 20_000 }, async () => {
    await mount([doneTool("call_1", { transactions: new Array(142).fill({}) })]);
    fireEvent.click(await screen.findByRole("button", { expanded: false }));
    const beat = document.querySelector("[data-vendo-tool='host_list_transactions']");
    expect(beat?.textContent).toContain("List transactions");
    expect(beat?.textContent).toContain("142 transactions");
    expect(screen.queryByText(/host_list_transactions/)).toBeNull();
  });

  // Restored history arrives folded — no beat entrance stampede, and the row
  // claims no duration for work nobody watched.
  it("restores a turn folded, counting its steps without inventing a duration", { timeout: 20_000 }, async () => {
    await mount([
      doneTool("call_1", { rows: [] }, { month: "july" }),
      doneTool("call_2", { rows: [] }, { month: "august" }),
      { type: "text", text: "Here's what I found." } as Thread["messages"][number]["parts"][number],
    ]);
    const summary = document.querySelector(".fl-beatsummary");
    expect(summary?.textContent).toBe("Did 2 things");
    expect(document.querySelectorAll(".fl-beat")).toHaveLength(0);
    expect(document.querySelector(".fl-turn-assistant")?.classList.contains("fl-no-entrance")).toBe(true);
  });

  // C3 / D1 — the app card narrates its own step ("Building your view…" → the
  // app's name), so the call behind it leaves no beat; the summary still counts
  // the step, so the record stays honest.
  it("renders NO beat for the apps call whose result became the app card, but still counts it", { timeout: 20_000 }, async () => {
    const payload = {
      formatVersion: "vendo-genui/v2",
      name: "Renewals radar",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["note"] },
        { id: "note", component: "Text", props: { text: "Seven renewals." } },
      ],
    };
    await mount([
      {
        type: "dynamic-tool",
        toolName: "vendo_apps_create",
        toolCallId: "call_build",
        state: "output-available",
        input: { appId: "app_renewals" },
        output: { kind: "tree", appId: "app_renewals", payload },
      },
      { type: "data-vendo-view", data: { appId: "app_renewals", payload } },
    ] as unknown as Thread["messages"][number]["parts"]);
    // The card is present and IS the step.
    expect(document.querySelector("[data-vendo-app-embed='app_renewals']")).toBeTruthy();
    expect(document.querySelector(".fl-beatsummary")?.textContent).toBe("Did 1 thing");
    // Reopening the row still shows no beat for the build — not even folded away.
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(document.querySelector("[data-vendo-tool='vendo_apps_create']")).toBeNull();
    expect(screen.queryByText(/Build an app/)).toBeNull();
  });

  // Spec §15 — failure is conversation. The ✕ beat stays in the record even
  // while the turn is folded, and NOTHING else appears: no retry button, no
  // chip, no card. The recovery is the agent's own next sentence (a text part),
  // plus the shipped composer and Regenerate affordances.
  it("keeps the ✕ beat and grows ZERO failure components", { timeout: 20_000 }, async () => {
    await mount([
      failedTool("call_1"),
      { type: "text", text: "That pull timed out and nothing was changed. I'll take July in two halves." } as Thread["messages"][number]["parts"][number],
    ]);
    const turn = document.querySelector(".fl-turn-assistant") as HTMLElement;
    const errorBeat = turn.querySelector(".fl-beat-error");
    expect(errorBeat).toBeTruthy();
    expect(errorBeat?.textContent).toContain("couldn't finish");
    // The prose recovery streamed as a text part, exactly like any other line.
    expect(turn.textContent).toContain("nothing was changed");
    // Zero failure furniture anywhere in the turn.
    for (const selector of [
      ".fl-chip", ".fl-cardshell", ".fl-approval", ".fl-buildfail",
      ".fl-btn-primary", ".fl-btn-ceremony", ".fl-connect", ".fl-waiting",
    ]) {
      expect(turn.querySelector(selector), selector).toBeNull();
    }
    for (const button of Array.from(document.querySelectorAll("button"))) {
      expect(button.textContent ?? "", button.outerHTML).not.toMatch(/retry|try again|re-?run|fix it/i);
    }
    // The errorText is a provider string — never rendered raw to a person.
    expect(screen.queryByText(/upstream 500/)).toBeNull();
  });
});

/** V4 (spec §5) — the plan-time display hint. Lane E supplies the field; the
 *  transcript's only job is the trigger: a "stage" view opens the workspace at
 *  build start, on a LIVE turn, and never fights a user who took Back-to-chat. */
describe("the V4 display hint", () => {
  afterEach(cleanup);

  function viewPart(display?: "inline" | "stage"): UIMessage["parts"][number] {
    return {
      type: "data-vendo-view",
      data: {
        appId: "app_big",
        payload: {
          formatVersion: "vendo-genui/v2",
          name: "Cash flow",
          root: "root",
          nodes: [{ id: "root", component: "Text", props: { text: "Assembling." } }],
          ...(display === undefined ? {} : { display }),
        },
      },
    } as unknown as UIMessage["parts"][number];
  }

  function split(overrides: Partial<SplitViewContextValue> = {}): SplitViewContextValue {
    return {
      expanded: false,
      featuredAppId: undefined,
      feature: vi.fn(),
      expandTo: vi.fn(),
      registerEmbed: vi.fn(),
      removeEmbed: vi.fn(),
      ...overrides,
    };
  }

  function mountCard(part: UIMessage["parts"][number], value: SplitViewContextValue, restored = false) {
    return render(
      <VendoProvider>
        <SplitViewContext.Provider value={value}>
          <ThreadPart part={part} partKey="p0" role="assistant" restored={restored} risks={new Map()} />
        </SplitViewContext.Provider>
      </VendoProvider>,
    );
  }

  it("stages the view at build start when the brain hinted stage", () => {
    const value = split();
    mountCard(viewPart("stage"), value);
    expect(value.expandTo).toHaveBeenCalledWith("app_big");
  });

  it("leaves an unhinted (or inline) view exactly as it is today", () => {
    const bare = split();
    mountCard(viewPart(), bare);
    expect(bare.expandTo).not.toHaveBeenCalled();
    cleanup();
    const inline = split();
    mountCard(viewPart("inline"), inline);
    expect(inline.expandTo).not.toHaveBeenCalled();
  });

  it("never reopens a stage for restored history, and never re-stages an already-open workspace", () => {
    const restored = split();
    mountCard(viewPart("stage"), restored, true);
    expect(restored.expandTo).not.toHaveBeenCalled();
    cleanup();
    const open = split({ expanded: true, featuredAppId: "app_big" });
    mountCard(viewPart("stage"), open);
    expect(open.expandTo).not.toHaveBeenCalled();
  });

  it("respects Back-to-chat for the rest of the turn (fires once, never again)", () => {
    const part = viewPart("stage");
    const collapsed = split();
    const { rerender } = mountCard(part, collapsed);
    expect(collapsed.expandTo).toHaveBeenCalledTimes(1);
    const tree = (value: SplitViewContextValue) => (
      <VendoProvider>
        <SplitViewContext.Provider value={value}>
          <ThreadPart part={part} partKey="p0" role="assistant" restored={false} risks={new Map()} />
        </SplitViewContext.Provider>
      </VendoProvider>
    );
    // The stage opened…
    rerender(tree(split({ expanded: true, featuredAppId: "app_big" })));
    // …and the user took Back-to-chat: the hint does not drag them back.
    const afterBack = split();
    rerender(tree(afterBack));
    expect(afterBack.expandTo).not.toHaveBeenCalled();
  });
});
