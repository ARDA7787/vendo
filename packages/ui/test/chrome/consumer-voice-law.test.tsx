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

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { AdoptionCard, ConnectCard, GrantSetCard, type GrantSetPermission } from "../../src/chrome/index.js";
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
