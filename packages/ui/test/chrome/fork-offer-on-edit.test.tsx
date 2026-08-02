// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoPage } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/**
 * Build contract §9.4 — `forbidden` exists for exactly one case: a caller who
 * provably SEES the app is denied a change. That case is answerable, and the
 * consumer-voice fork offer is the answer ("I can't change the team's copy, but
 * I can make you your own").
 *
 * The offer was mounted only off the REMOVE button, so the verb the code was
 * invented for — the edit — showed the raw refusal string instead.
 */
describe("the fork offer answers an EDIT a viewer may not make", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const openApps = async (): Promise<void> => {
    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    await screen.findByText("Invoices", {}, { timeout: 12000 });
  };

  const askForAChange = (appName: string, asked: string): void => {
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    const field = screen.getByRole("form", { name: `Change ${appName}` })
      .querySelector("input") as HTMLInputElement;
    fireEvent.change(field, { target: { value: asked } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  };

  it("offers the fork, in the person's own words, instead of the refusal string", async () => {
    const refusal = Object.assign(new Error("editor access is required for app_1"), { code: "forbidden" });
    vi.spyOn(client.apps, "edit").mockRejectedValue(refusal);
    await openApps();

    askForAChange("Invoices", "show last quarter too");

    const offer = await screen.findByText(/I can’t change the team’s copy/i, {}, { timeout: 12000 });
    // "Friendly is not vague" — the offer carries what they actually asked for.
    expect(offer.textContent).toContain("show last quarter too");
    expect(screen.queryByText(/editor access is required/)).toBeNull();
    expect(screen.queryByText(/app_1$/)).toBeNull();
  });

  it("makes them their own copy when they take the offer", async () => {
    vi.spyOn(client.apps, "edit").mockRejectedValue(
      Object.assign(new Error("editor access is required for app_1"), { code: "forbidden" }),
    );
    const forked = vi.spyOn(client.apps, "fork");
    await openApps();
    askForAChange("Invoices", "make it monthly");

    fireEvent.click(await screen.findByRole("button", { name: "Make me my own copy" }, { timeout: 12000 }));
    await waitFor(() => expect(forked).toHaveBeenCalledWith("app_1"));
    await waitFor(() => expect(screen.queryByText(/I can’t change the team’s copy/i)).toBeNull());
  });

  it("still shows an ordinary failure as an ordinary failure", async () => {
    // The offer is for `forbidden` ALONE. Anything else is not "you may not",
    // so answering it with "want your own copy?" would be a lie.
    vi.spyOn(client.apps, "edit").mockRejectedValue(
      Object.assign(new Error("the model is unavailable"), { code: "unavailable" }),
    );
    await openApps();
    askForAChange("Invoices", "add a chart");

    expect((await screen.findByRole("alert", {}, { timeout: 12000 })).textContent)
      .toContain("the model is unavailable");
    expect(screen.queryByText(/I can’t change the team’s copy/i)).toBeNull();
  });
});
