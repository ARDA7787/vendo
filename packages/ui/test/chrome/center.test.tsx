// @vitest-environment jsdom
/**
 * The AI center (redesign spec §10 X1 / §12 page-inside-host-app / §14 cold
 * start): VendoPage is no longer five tabs over a card — it is an in-page rail
 * (New chat · Apps · Automations · Needs-you · chats) beside one column.
 *
 * What this file pins is the SHELL's behavior, the part a restyle must not
 * quietly lose:
 *  - the rail carries no brand row and no user row (§12: the host's app is the
 *    frame; we never bring an app shell of our own);
 *  - "Needs you" exists ONLY while asks are waiting, with the count on it;
 *  - the home shelf is ghost tiles at zero apps (§14 CS2) and live tiles once
 *    an app exists;
 *  - conversations group by recency;
 *  - the section switcher keeps real tab semantics (roving focus, one selected
 *    tab, a labelled panel) — §13 strangers means nothing here reaches for the
 *    overlay.
 */
import type { ApprovalRequest, AppDocument } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, type VendoClient } from "../../src/index.js";
import { VendoPage } from "../../src/chrome/index.js";
import { markSeen } from "../../src/chrome/discoverability.js";
import type { ThreadSummary } from "../../src/wire-types.js";

const DAY_MS = 86_400_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

function appDoc(id: string, name: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name,
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: `${name} app surface` } }],
    },
  } as AppDocument;
}

function ask(id: string, tool = "host_email_send"): ApprovalRequest {
  return {
    id,
    call: { id: `call_${id}`, tool, args: { to: "a@example.com" } },
    descriptor: { name: tool, description: "Send email", inputSchema: { type: "object" }, risk: "write" },
    inputPreview: "to a@example.com",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
    createdAt: iso(60_000),
  } as ApprovalRequest;
}

/** A client with no server behind it: every read the center makes, stubbed. */
function stubClient(over: {
  threads?: ThreadSummary[];
  apps?: AppDocument[];
  pending?: () => ApprovalRequest[];
} = {}): VendoClient {
  const apps = over.apps ?? [];
  const pending = over.pending ?? (() => []);
  return {
    baseUrl: "http://vendo.test",
    headers: {},
    async status() { return { posture: "unconfigured", version: "test", blocks: {} }; },
    threads: {
      async list() { return over.threads ?? []; },
      async get(id: string) { return { id, subject: "user_1", messages: [], createdAt: iso(0), updatedAt: iso(0) }; },
      async delete() { return undefined; },
    },
    apps: {
      async list() { return apps; },
      async get(id: string) { return apps.find(app => app.id === id) ?? apps[0]!; },
      async open(id: string) {
        const app = apps.find(item => item.id === id) ?? apps[0]!;
        return { kind: "tree", payload: (app as { tree: unknown }).tree };
      },
      async create() { return apps[0]!; },
      async delete() { return undefined; },
      async fork() { return apps[0]!; },
      async edit() { return { app: apps[0]! }; },
      async pingMachine() { return undefined; },
    },
    approvals: {
      async pending() { return pending(); },
      async decide() { return { decided: [] }; },
    },
    automations: { async list() { return []; } },
    runs: { async list() { return { runs: [] }; } },
    grants: { async list() { return []; } },
    connections: { async list() { return []; }, async catalog() { return []; } },
    activity: { async list() { return []; } },
  } as unknown as VendoClient;
}

const mount = (client: VendoClient) =>
  render(<VendoProvider client={client}><VendoPage /></VendoProvider>);

beforeEach(() => {
  window.localStorage.clear();
  // The one-time greeting-as-tutorial is its own surface (discoverability §6);
  // these cases are about the shell around it.
  markSeen("greeting");
});
afterEach(cleanup);

describe("the center rail", () => {
  it("is an in-page rail: the named doors, no brand row, no user row", async () => {
    mount(stubClient());
    const tabs = await screen.findByRole("tablist", { name: "Workspace sections" });
    expect(tabs.getAttribute("aria-orientation")).toBe("vertical");
    for (const name of ["New chat", "Apps", "Automations"]) {
      expect(within(tabs).getByRole("tab", { name })).toBeTruthy();
    }
    // §12 — the host's app supplies its own chrome: we bring neither identity
    // nor an account row.
    expect(screen.queryByRole("tab", { name: "Chat" })).toBeNull();
    expect(screen.queryByText(/signed in|account|user_1/i)).toBeNull();
    // §13 — strangers: nothing in the center offers to hand off to the overlay.
    expect(screen.queryByText(/open in assistant/i)).toBeNull();
  });

  it("moves Activity and Accounts under the quiet ··· row, opening the existing panels", async () => {
    mount(stubClient());
    await screen.findByRole("tablist", { name: "Workspace sections" });
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
    const more = screen.getByRole("button", { name: "More sections" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Accounts" }));
    expect(await screen.findByRole("heading", { name: "Connected accounts" })).toBeTruthy();
  });

  // APG MANUAL activation (H18). This case previously asserted the opposite —
  // that an arrow key activated the row it landed on — which is the destructive
  // behavior itself: "New chat" is an ACT (it discards the open conversation and
  // the composer's draft), so arrowing past it threw the user's work away.
  it("keeps roving tab semantics: arrows move focus, Enter activates, the panel is labelled", async () => {
    mount(stubClient());
    const chat = await screen.findByRole("tab", { name: "New chat" });
    expect(chat.getAttribute("aria-selected")).toBe("true");
    expect(chat.getAttribute("tabindex")).toBe("0");
    const apps = screen.getByRole("tab", { name: "Apps" });
    expect(apps.getAttribute("tabindex")).toBe("-1");
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowDown" });
    // Focus moved, and the roving stop moved with it — but NOTHING was chosen.
    expect(document.activeElement).toBe(apps);
    expect(apps.getAttribute("tabindex")).toBe("0");
    expect(apps.getAttribute("aria-selected")).toBe("false");
    expect(chat.getAttribute("aria-selected")).toBe("true");
    // Enter is what chooses (Space too — it is a real <button>).
    fireEvent.click(apps);
    expect(apps.getAttribute("aria-selected")).toBe("true");
    expect(chat.getAttribute("aria-selected")).toBe("false");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(apps.getAttribute("id"));
  });

  it("an arrow key never starts a new chat: the open conversation survives (H18)", async () => {
    mount(stubClient({ threads: [{ id: "thr_1", title: "Where did July go?", updatedAt: iso(0) }] as ThreadSummary[] }));
    const row = await screen.findByRole("button", { name: "Where did July go?" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("page"));
    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    const apps = screen.getByRole("tab", { name: "Apps" });
    apps.focus();
    // ArrowUp lands on "New chat". Under automatic activation this fired
    // conversation.choose(undefined) — the open conversation and the draft in
    // its composer, gone, from a keystroke that was only meant to move.
    fireEvent.keyDown(apps, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "New chat" }));
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(apps.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { name: "Apps" })).toBeTruthy();
  });

  it("closing ··· on an open Activity keeps a tab stop and a named panel (H10)", async () => {
    mount(stubClient());
    await screen.findByRole("tablist", { name: "Workspace sections" });
    const more = screen.getByRole("button", { name: "More sections" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
    // Fold the row away again while Activity is what the column shows.
    fireEvent.click(more);
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
    // The tablist still has exactly one keyboard entry point…
    const stops = screen.getAllByRole("tab").filter(tab => tab.getAttribute("tabindex") === "0");
    expect(stops.length).toBe(1);
    // …and the panel still has a NAME (its label can no longer be a tab that
    // does not exist).
    const panel = screen.getByRole("tabpanel", { name: "Activity" });
    expect(panel.getAttribute("aria-labelledby")).toBeNull();
  });

  it("groups conversations by recency and titles each row with its opening line", async () => {
    mount(stubClient({
      threads: [
        { id: "thr_today", title: "Where did July go?", updatedAt: iso(3_600_000) },
        { id: "thr_week", title: "Build me a spending breakdown", updatedAt: iso(3 * DAY_MS) },
        { id: "thr_old", title: "An old question", updatedAt: iso(90 * DAY_MS) },
      ] as ThreadSummary[],
    }));
    expect(await screen.findByText("Today")).toBeTruthy();
    expect(screen.getByText("Previous 7 days")).toBeTruthy();
    expect(screen.getByText("Earlier")).toBeTruthy();
    const groups = screen.getAllByRole("group");
    const today = groups.find(group => group.textContent?.startsWith("Today"))!;
    expect(within(today).getByRole("button", { name: "Where did July go?" })).toBeTruthy();
    expect(within(today).queryByRole("button", { name: "An old question" })).toBeNull();
  });
});

describe("Needs you", () => {
  it("exists only while asks are waiting, and carries the count", async () => {
    let waiting = [ask("apr_1"), ask("apr_2", "host_transfer_send")];
    mount(stubClient({ pending: () => waiting }));
    const section = await screen.findByRole("region", { name: /Needs you/ });
    expect(within(section).getByText("2")).toBeTruthy();
    // Settle them; the section retires on the next poll rather than lingering
    // as an empty header.
    waiting = [];
    await waitFor(
      () => expect(screen.queryByRole("region", { name: /Needs you/ })).toBeNull(),
      { timeout: 12000 },
    );
  });

  it("is absent from the first paint when nothing is waiting", async () => {
    mount(stubClient());
    await screen.findByRole("tab", { name: "Apps" });
    expect(screen.queryByRole("region", { name: /Needs you/ })).toBeNull();
    expect(screen.queryByText("Needs you")).toBeNull();
  });
});

describe("the home shelf", () => {
  it("day zero: ghost tiles advertise what to build (§14 CS2)", async () => {
    mount(stubClient());
    const shelf = await screen.findByRole("region", { name: "What you could build" });
    const ghosts = within(shelf).getAllByRole("button");
    expect(ghosts.length).toBeGreaterThan(0);
    expect(shelf.textContent).toMatch(/tap to build/i);
    expect(screen.queryByRole("region", { name: "Your apps" })).toBeNull();
  });

  it("once an app exists the ghosts are gone and the shelf is live", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    const shelf = await screen.findByRole("region", { name: "Your apps" });
    expect(within(shelf).getByRole("button", { name: "Open Invoices" })).toBeTruthy();
    // A LIVE tile: the app's own rendered view, not its name on a card.
    expect(await within(shelf).findByText("Invoices app surface")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What you could build" })).toBeNull();
  });
});

describe("mobile P1 (§12)", () => {
  const TAKEOVER_QUERY = "(max-width: 767px)";
  /** jsdom has no matchMedia; only the takeover query matches (the same stub
   *  shape mobile-takeover.test.tsx installs). */
  // Restored after each case: a leaked stub would render every later case
  // (and every later FILE, under the same worker) as the mobile takeover.
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  afterEach(() => {
    if (original) Object.defineProperty(window, "matchMedia", original);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  });
  const installMobile = () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === TAKEOVER_QUERY,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  };

  it("is one page under the host's route: a compact header and a slide-in history sheet", async () => {
    installMobile();
    mount(stubClient({ threads: [{ id: "thr_1", title: "Where did July go?", updatedAt: iso(0) }] as ThreadSummary[] }));
    // The header, not a second app bar: no tablist, no brand row, no user row.
    expect(await screen.findByText("Assistant")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Assistant sections" });
    for (const name of ["Chats", "Apps", "Automations", "New"]) {
      expect(within(nav).getByRole("button", { name })).toBeTruthy();
    }
    // History is a sheet, opened from the header and dismissable.
    const chats = within(nav).getByRole("button", { name: "Chats" });
    expect(chats.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("complementary", { name: "Conversations" })).toBeNull();
    fireEvent.click(chats);
    const sheet = await screen.findByRole("complementary", { name: "Conversations" });
    expect(within(sheet).getByRole("button", { name: "Where did July go?" })).toBeTruthy();
    // The panels the desktop rail folds under ··· live in the sheet on mobile.
    expect(within(sheet).getByRole("button", { name: "Activity" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close conversations" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Conversations" })).toBeNull());
  });
});

describe("the named doors", () => {
  it("Apps opens the tile grid with the honest empty line, and the caption points at the composer", async () => {
    mount(stubClient());
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    expect(await screen.findByRole("heading", { name: "Apps" })).toBeTruthy();
    expect(screen.getByText(/nothing yet/i)).toBeTruthy();
    expect(screen.getByText(/ask below to build a new one/i)).toBeTruthy();
  });

  it("Apps: a tile opens the app full in the column", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Invoices" }));
    const open = await screen.findByRole("region", { name: "Invoices" });
    expect(within(open).getByText("Invoices app surface")).toBeTruthy();
  });

  it("Automations opens the existing panel, unchanged", async () => {
    mount(stubClient());
    fireEvent.click(await screen.findByRole("tab", { name: "Automations" }));
    expect(await screen.findByRole("heading", { name: "Automations" })).toBeTruthy();
    expect(screen.getByText(/no automations yet/i)).toBeTruthy();
  });
});
