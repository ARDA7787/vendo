// @vitest-environment jsdom
/**
 * spec §16 law 3 — the consumer-voice guarantees, asserted through the REAL
 * components: no developer sentence, no id, no raw error ever reaches an
 * end-user surface.
 *
 * Every case here was seen LIVE on demo-bank during the redesign wave. The law
 * is not "our copy is nice"; it is that strings authored for a MODEL or a HOST
 * DEVELOPER have a different home (the model's own context, the server log, the
 * dev-mode console) and must not arrive on a bank customer's screen.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import {
  ActivityPanel,
  AdoptionCard,
  AutomationCard,
  AutomationsPanel,
  ConnectCard,
  ConnectedAccountsPanel,
  GrantSetCard,
  WaitingQueue,
  type GrantSetPermission,
} from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

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

/** The exact string seen on `standing-01-pending.png`, from demo-bank's own
 *  `.vendo/tools.json` — a sentence written for the MODEL, rendered faithfully
 *  at a bank customer. */
const MODEL_INSTRUCTION =
  "Spending by category for the current period. Amounts are integer cents"
  + " (e.g. 285000 = $2,850.00): divide by 100 exactly once before displaying,"
  + " including any totals you compute. Do not re-divide.";

/** The wire part carries the descriptor's description and `thread/parts.tsx`
 *  casts it straight into the card's props — so the cast is how a description
 *  reaches this component in production, and the cast is what the law has to
 *  survive. */
const wirePermissions = (description: string): GrantSetPermission[] => ([
  { approvalId: "apr_1", tool: "host_getSpendingInsights", description, risk: "read" },
  { approvalId: "apr_2", tool: "host_transferMoney", description, risk: "destructive" },
] as unknown as GrantSetPermission[]);

/** The widened audit's vocabulary: what a developer string LOOKS like. Every
 *  one of these was seen on a consumer surface in this wave. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["an id-shaped token", /\b[a-z]{2,6}_[A-Za-z0-9]{4,}/],
  ["code-call syntax", /\b[A-Za-z_$][\w$]*\(\s*[\w$"'{[]/],
  ["a dotted identifier path", /\b[a-z]{2,}[A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]+)+\b/],
  ["an environment variable", /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/],
  ["a configuration instruction", /pass a |set VENDO_|createVendo\(/],
  ["a model instruction", /\be\.g\.|\bdivide by \d|\bdo not\b|\binteger cents\b/i],
];

/** Everything a person can READ or HEAR from a rendered surface: every text node
 *  plus every accessible name, one per line so adjacent nodes cannot glue into a
 *  token neither of them contains. The `title` attribute is deliberately
 *  excluded — the consent honesty contract keeps the RAW argument value one hover
 *  away, on purpose.
 *
 *  Real user content is not our plumbing: an email address or a URL a person
 *  typed (or a tool is sending) belongs on the screen, so those are lifted out
 *  before the dotted-path check. */
function readable(root: ParentNode): string {
  const lines: string[] = [];
  const walker = (root.ownerDocument ?? (root as Document))
    .createTreeWalker(root as Node, 4 /* NodeFilter.SHOW_TEXT */);
  while (walker.nextNode()) lines.push(walker.currentNode.textContent ?? "");
  for (const node of root.querySelectorAll("[aria-label]")) lines.push(node.getAttribute("aria-label") ?? "");
  return lines.join("\n").replace(/[\w.+-]+@[\w.-]+|https?:\/\/\S+/g, " ");
}

function auditReadable(root: ParentNode, surface: string): void {
  const text = readable(root);
  for (const [label, pattern] of FORBIDDEN) {
    const hit = pattern.exec(text);
    expect(hit === null ? "" : `${surface} rendered ${label}: ${hit[0]}`).toBe("");
  }
}

describe("LEAK 1 — the standing-access card rendered model instructions", () => {
  it("never prints a model-authored descriptor description on a grant row", () => {
    render(
      <VendoProvider client={client}>
        <GrantSetCard name="Spending watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: /Standing access/ });
    expect(card.textContent).not.toContain("integer cents");
    expect(card.textContent).not.toContain("e.g.");
    expect(card.textContent).not.toContain("divide by 100");
    expect(card.textContent).not.toContain("Do not");
  });

  it("describes each permission in OUR words instead — the verb and the thing", () => {
    render(
      <VendoProvider client={client}>
        <GrantSetCard name="Spending watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />
      </VendoProvider>,
    );
    const rows = [...document.querySelectorAll(".fl-grant")].map(row => row.textContent);
    expect(rows).toEqual(["Reads: Get spending insights", "Changes: Transfer money"]);
    // The cadence stays on the card's own plain-words line, said once.
    expect(document.querySelector(".fl-card-line")?.textContent)
      .toContain("Granted once, used every run");
  });

  it("keeps the HOST's own consumer sentence, which is the one authored for people", () => {
    render(
      <VendoProvider client={client} tools={{ host_getSpendingInsights: { description: "Reads your spending totals." } }}>
        <GrantSetCard name="Spending watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: /Standing access/ });
    expect(card.textContent).toContain("Reads your spending totals.");
    expect(card.textContent).not.toContain("integer cents");
  });

  it("holds on the paused-automation card too — the same rows, the same wire description", () => {
    render(
      <VendoProvider client={client}>
        <AdoptionCard
          card={{
            appId: "app_1",
            automation: "Spending watcher",
            reason: "departure",
            sponsor: "Dana",
            needs: [{
              tool: "host_getSpendingInsights",
              title: "host_getSpendingInsights",
              description: MODEL_INSTRUCTION,
              risk: "read",
            }],
          }}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: /Take on/ });
    expect(card.textContent).not.toContain("integer cents");
    expect(card.textContent).not.toContain("e.g.");
    // And the row still says what the automation does, in our words.
    expect(document.querySelector(".fl-grant")?.textContent).toContain("Reads: Get spending insights");
  });
});

describe("LEAK 2 — the connect card printed the wire's developer sentence", () => {
  /** The real refusal from a keyless (default OSS) deployment: it names a
   *  TypeScript call and an environment variable. */
  const developerSentence =
    "connected accounts are not configured: pass a Composio connector (composioConnector)"
    + " to createVendo({ connectors }) or set VENDO_API_KEY for the Vendo Cloud broker";

  const failing = (code: string | undefined) => {
    const base = createVendoClient({ baseUrl: wire.url });
    const reason = Object.assign(new Error(developerSentence), code === undefined ? {} : { code });
    return {
      ...base,
      connections: { ...base.connections, initiate: async () => { throw reason; } },
    } as unknown as VendoClient;
  };

  const clickConnect = async (bound: VendoClient) => {
    render(
      <VendoProvider client={bound}>
        <ConnectCard connector="composio" toolkit="slack" message="Connect Slack to post." onConnected={() => undefined} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    return await waitFor(() => screen.getByRole("alert"));
  };

  it("tells the person what it means for them, never how to configure the SDK", async () => {
    const alert = await clickConnect(failing("not-implemented"));
    expect(alert.textContent).not.toContain("createVendo");
    expect(alert.textContent).not.toContain("VENDO_API_KEY");
    expect(alert.textContent).not.toContain("pass a");
    expect(alert.textContent).toMatch(/isn’t set up/i);
    expect(alert.textContent).toContain("Slack");
  });

  it("stays consumer-voiced for an uncoded failure too (OAuth failed, expired, timed out)", async () => {
    const alert = await clickConnect(failing(undefined));
    expect(alert.textContent).not.toContain("createVendo");
    expect(alert.textContent).not.toContain("composioConnector");
    expect(alert.textContent).toMatch(/couldn’t finish connecting Slack/i);
  });

  it("keeps the developer sentence for developers — the dev-mode console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await clickConnect(failing("not-implemented"));
      await waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("createVendo"));
    } finally {
      process.env.NODE_ENV = previous;
      warn.mockRestore();
    }
  });
});

/** The set card's own refusal was the same defect: it rendered `reason.message`
 *  from whatever the caller's decide threw. */
describe("LEAK 2, the sibling — the standing-access card's own refusal", () => {
  it("shows a consumer sentence when the decision does not go through", async () => {
    render(
      <VendoProvider client={client}>
        <GrantSetCard
          name="Spending watcher"
          permissions={wirePermissions("")}
          state="parked"
          onDecide={() => { throw Object.assign(new Error("grant set gset_1 not found for app app_9"), { code: "not-found" }); }}
        />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /allow both/i }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).not.toContain("gset_1");
    expect(alert.textContent).not.toContain("app_9");
    expect(alert.textContent).toMatch(/isn’t available/i);
  });
});

/**
 * THE WIDENED AUDIT — every chrome surface, not just the cards.
 *
 * Two halves, because each catches what the other cannot: a RENDER sweep (what
 * actually reaches the screen, with hostile data pushed through the real
 * components) and a SOURCE sweep (the shapes that let developer strings onto a
 * screen in the first place, so the class cannot come back through a file this
 * wave never looked at).
 */
describe("the widened audit — no chrome surface renders a developer string", () => {
  /** Every surface a person can reach, mounted the way a host mounts it. The
   *  wire fixture is deliberately full of our plumbing (app_auto, apr_set_1,
   *  gset_1, grt_1, tool slugs, canonical previews), so a surface that prints
   *  any of it fails here. */
  const SURFACES: Array<[string, React.ReactNode]> = [
    ["standing access", <GrantSetCard name="Invoice watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />],
    ["standing access, settled", <GrantSetCard name="Invoice watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="approved" />],
    ["connect", <ConnectCard connector="composio" toolkit="googlecalendar" message="Connect Google Calendar to check your day." onConnected={() => undefined} />],
    ["automation", <AutomationCard name="Low balance alert" enabled description="Emails you when checking dips." />],
    ["paused adoption", <AdoptionCard card={{
      appId: "app_7f3a2b41",
      automation: "Weekly sweep",
      reason: "grants",
      sponsor: "Dana",
      needs: [
        { tool: "host_getSpendingInsights", title: "host_getSpendingInsights", description: MODEL_INSTRUCTION, risk: "read" },
        { tool: "gmail_GMAIL_SEND_EMAIL", title: "Send email", risk: "write" },
      ],
    }} />],
    ["waiting strip", <WaitingQueue pollMs={0} />],
    ["activity", <ActivityPanel />],
    ["automations panel", <AutomationsPanel />],
    ["connected accounts", <ConnectedAccountsPanel />],
  ];

  it("sweeps every surface for ids, code, dotted paths, env vars and config instructions", async () => {
    for (const [surface, node] of SURFACES) {
      const view = render(<VendoProvider client={client}>{node}</VendoProvider>);
      // Let the wire-backed surfaces paint their real content before auditing.
      await waitFor(() => expect(view.container.textContent?.length ?? 0).toBeGreaterThan(0));
      auditReadable(view.container, surface);
      cleanup();
    }
  });

  /**
   * The SHAPES that produce the leak, across every chrome and voice source —
   * widened from the wave's ten-file card list to the whole tree, recursively.
   *
   * `KNOWN_OPEN` is not an excuse list: each entry is a live violation this lane
   * could not close, with the reason. Two are in files owned by other workers in
   * this wave; the rest are named in the lane report.
   */
  const KNOWN_OPEN: Record<string, string> = {
    "approval-card.tsx": "owned by another worker this wave — renders `reason.message` on a failed decision (line 117) AND `descriptor.description` as the plain-words line (line 89)",
    "thread/composer.tsx": "owned by another worker this wave — an attachment read error renders raw (line 141)",
    "embeds.tsx": "decided exception, documented at the render site: the BYO-agent embed's contract (embeds.test) is that the wire failure stays legible",
    "automations-panel.tsx": "a run-history row prints the run's own error code + message (line 568), and the disable-repair sentence folds the wire message in (line 275) — both need a product decision about what a failed unattended run may say to its owner",
  };

  const chromeSources = (): string[] => {
    const collect = (dir: string): string[] =>
      readdirSync(join("src", dir), { recursive: true, encoding: "utf8" })
        .filter(name => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
        .map(name => `${dir}/${name}`);
    return [...collect("chrome"), ...collect("voice")];
  };

  it("has no NEW raw-error render anywhere under src/chrome or src/voice", () => {
    // Two shapes: the JSX render of a failure's own sentence (`{error.message}`,
    // never a `${...}` interpolation or a consumer-authored `message` prop), and
    // the state write that feeds one (`setError(reason instanceof Error ? …)`).
    const RAW_RENDER = /(?<![$`])\{[^{}\n]*\b(?:error|err|reason|failure|cause)\.message\s*\}/i;
    const RAW_STATE = /set\w*Error\w*\(\s*\w+\s+instanceof\s+Error\s*\?/;
    const offenders = chromeSources().filter(file => {
      // Comments and dev-mode console rails are the developer's own channel.
      const source = readFileSync(join("src", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ")
        .replace(/console\.\w+\([\s\S]*?\);/g, " ");
      return RAW_RENDER.test(source) || RAW_STATE.test(source);
    });
    const unexpected = offenders.filter(file => KNOWN_OPEN[file.replace(/^chrome\//, "")] === undefined);
    expect(unexpected).toEqual([]);
    // And the list stays honest: an entry that stops being a violation must be
    // deleted, so the table can never rot into a blanket exemption.
    const stale = Object.keys(KNOWN_OPEN)
      .filter(name => !offenders.some(file => file.replace(/^chrome\//, "") === name));
    expect(stale).toEqual([]);
  });

  it("has no developer configuration sentence in any chrome copy", () => {
    // The exact phrases the wire's own refusals use. A component may only ever
    // hand these to the dev-mode console, never to a rendered string, so the
    // console lines are stripped before the scan.
    const CONFIG_PHRASE = /(?:pass a |set VENDO_|createVendo\()/;
    const offenders = chromeSources().filter(file => {
      const source = readFileSync(join("src", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ")
        .replace(/console\.\w+\([\s\S]*?\);/g, " ");
      return CONFIG_PHRASE.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
