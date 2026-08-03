// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, useAttention, type VendoClient } from "../src/index.js";
import { createWireServer } from "./wire-server.js";

/**
 * Post-check H15 — the ONE approvals poller. The launcher pill, the waiting
 * strip and the center's rail all read the same asks; before this they each
 * held their own interval, so a host mounting both surfaces spent 36 requests a
 * minute with nothing waiting.
 *
 * Every assertion here is RELATIVE (three surfaces cost what one costs) rather
 * than a count of ticks in a window, so a slow machine can't turn the invariant
 * into a flake.
 */

const CADENCE_MS = 25;
const WINDOW_MS = 250;

function Surface({ pollMs }: { pollMs: number }) {
  const { askCount, asks, decide } = useAttention({ pollMs });
  return (
    <>
      <span data-testid="count">{askCount}</span>
      <button type="button" onClick={() => void decide(asks.map(ask => ask.id), { approve: true })}>Approve</button>
    </>
  );
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("the shared approvals feed", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    // A fresh client per test is a fresh feed (the store is keyed by client).
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  const polls = () => wire.requests.filter(request => request.method === "GET" && request.path === "/approvals").length;

  it("mounts three surfaces on ONE request, and they all show the same count", async () => {
    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
      </VendoProvider>,
    );
    await waitFor(() => expect(view.getAllByTestId("count").map(node => node.textContent)).toEqual(["1", "1", "1"]));
    // The whole point: three mounted surfaces, one GET.
    expect(polls()).toBe(1);
  });

  it("costs the same to poll three surfaces as one", async () => {
    const single = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    await waitFor(() => expect(polls()).toBeGreaterThan(0));
    const before = polls();
    await settle(WINDOW_MS);
    const alone = polls() - before;
    single.unmount();
    expect(alone).toBeGreaterThan(1);

    const together = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
        <Surface pollMs={CADENCE_MS} />
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    const start = polls();
    await settle(WINDOW_MS);
    const shared = polls() - start;
    together.unmount();

    // Three independent pollers would be ~3× the single-surface cost; one
    // shared poller lands within a tick of it.
    expect(shared).toBeLessThanOrEqual(alone + 1);
  });

  it("stops entirely when the last surface unmounts", async () => {
    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    await waitFor(() => expect(polls()).toBeGreaterThan(1));
    view.unmount();
    const after = polls();
    await settle(WINDOW_MS);
    expect(polls()).toBe(after);
  });

  it("pauses while the document is hidden and catches up on return", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const show = (next: DocumentVisibilityState) => {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };

    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    await waitFor(() => expect(polls()).toBeGreaterThan(1));

    show("hidden");
    // The in-flight request may still land; one more is the ceiling.
    const paused = polls() + 1;
    await settle(WINDOW_MS);
    expect(polls()).toBeLessThanOrEqual(paused);

    const before = polls();
    show("visible");
    await waitFor(() => expect(polls()).toBeGreaterThan(before));
    view.unmount();
  });

  it("one decision clears every surface, with no extra fetch per surface", async () => {
    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
      </VendoProvider>,
    );
    await waitFor(() => expect(view.getAllByTestId("count").map(node => node.textContent)).toEqual(["1", "1", "1"]));
    const before = polls();
    fireEvent.click(view.getAllByRole("button", { name: "Approve" })[0]!);
    await waitFor(() => expect(view.getAllByTestId("count").map(node => node.textContent)).toEqual(["0", "0", "0"]));
    // One refresh answered all three surfaces, not one each.
    expect(polls()).toBe(before + 1);
    view.unmount();
  });
});
