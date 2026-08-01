// @vitest-environment jsdom
// Build contract §9.9 / design §13 — the adoption card and the window label.
// A stopped automation is a card ON THE APP (additive venue state on the open
// payload, served only to editors), and every automation says whose access it
// runs with.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { AdoptionCard, AutomationCard } from "../../src/chrome/index.js";
import { TreeView } from "../../src/tree/index.js";
import type { AdoptionVenue } from "../../src/wire-types.js";

afterEach(cleanup);

const client = createVendoClient({ baseUrl: "http://127.0.0.1:9" });
const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const WAITING: AdoptionVenue = {
  appId: "app_sweep",
  automation: "Weekly invoice sweep",
  sponsor: "Dana",
  reason: "edit",
  needs: [
    { tool: "host_listInvoices", title: "List invoices", description: "Read the invoice list", risk: "read" },
    {
      tool: "host_updateInvoice",
      title: "Update invoice",
      description: "Update an invoice",
      risk: "write",
      args: { invoice: "inv_42" },
    },
  ],
};

function treeWith(adoption?: AdoptionVenue): UIPayload {
  const tree: UIPayload & { adoption?: AdoptionVenue } = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["heading"] },
      { id: "heading", component: "Text", props: { text: "Invoices", variant: "heading" } },
    ],
  };
  if (adoption !== undefined) tree.adoption = adoption;
  return tree;
}

const surface = (adoption?: AdoptionVenue) => (
  <VendoProvider client={client}>
    <TreeView tree={treeWith(adoption)} components={{}} onAction={ok} />
  </VendoProvider>
);

describe("AdoptionCard", () => {
  it("says what stopped, who it ran as, and one line per read and write", () => {
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} />
      </VendoProvider>,
    );

    const card = screen.getByRole("article", { name: "Take on — Weekly invoice sweep" });
    expect(card.textContent).toContain("Weekly invoice sweep");
    expect(card.textContent).toContain("Dana");
    // §12 completeness: every read and write enumerated, never one summary
    // line for a compound, with the material arguments where they exist.
    expect(card.textContent).toContain("List invoices");
    expect(card.textContent).toContain("Update invoice");
    expect(card.textContent).toContain("inv_42");
  });

  it("hands the decision to the caller and reports a failure instead of pretending", async () => {
    const onAdopt = vi.fn().mockRejectedValue(new Error("someone else took it on"));
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} onAdopt={onAdopt} />
      </VendoProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /take it on/i }));

    await waitFor(() => expect(onAdopt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("someone else took it on"));
  });

  it("shows the settled record once it is adopted, with no decision left to make", () => {
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} state="adopted" />
      </VendoProvider>,
    );
    expect(screen.queryByRole("button", { name: /take it on/i })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/running again/i);
  });
});

describe("the adoption card as venue state", () => {
  it("renders above the app when one is waiting, and not otherwise", () => {
    render(surface());
    expect(screen.queryByRole("article", { name: /^Take on/ })).toBeNull();
    cleanup();

    render(surface(WAITING));
    expect(screen.getByRole("article", { name: "Take on — Weekly invoice sweep" })).toBeTruthy();
  });

  it("tolerates a malformed venue field without breaking the surface", () => {
    render(surface("nonsense" as unknown as AdoptionVenue));
    expect(screen.queryByRole("article", { name: /^Take on/ })).toBeNull();
    expect(screen.getByText("Invoices")).toBeTruthy();
  });
});

describe("the window label", () => {
  it("names whose access the automation runs with, and the wider editor set", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard
          name="Weekly invoice sweep"
          enabled
          sponsor={{ subject: "user_dana", display: "Dana" }}
          editors={3}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Weekly invoice sweep" });
    expect(card.textContent).toContain("Runs with Dana's access");
    expect(card.textContent).toContain("3 people can edit");
  });

  it("falls back to the subject when no display name is knowable, and stays quiet with no sponsor", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard name="Solo" enabled sponsor={{ subject: "user_dana" }} />
      </VendoProvider>,
    );
    expect(screen.getByRole("article", { name: "Automation — Solo" }).textContent)
      .toContain("Runs with user_dana's access");
    cleanup();

    render(
      <VendoProvider client={client}>
        <AutomationCard name="Unsponsored" enabled />
      </VendoProvider>,
    );
    expect(screen.getByRole("article", { name: "Automation — Unsponsored" }).textContent)
      .not.toContain("Runs with");
  });
});
