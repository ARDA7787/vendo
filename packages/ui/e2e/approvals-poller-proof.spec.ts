import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * Post-check H15, measured in a real browser: how many `GET /approvals` a host
 * that mounts BOTH surfaces actually spends in a minute with nothing waiting.
 *
 * The `/attention-surfaces` scenario is the realistic host — the center page
 * (its waiting strip + the rail's needs-you section) beside the overlay
 * launcher, three attention surfaces at 5s each. Before the shared feed that was
 * 3 pollers × 12 ticks = ~36 requests a minute, forever.
 *
 * A 60-second measurement, so it is opt-in rather than a minute on every run:
 *
 *   VENDO_POLLER_PROOF=1 pnpm --filter @vendoai/ui test:browser \
 *     e2e/approvals-poller-proof.spec.ts
 *
 * It writes the trace it measured next to the round's other evidence.
 */

const WINDOW_MS = 60_000;
const SURFACES = 3;
/** The cadence every attention surface asks for (launcher-status, waiting-queue, rail). */
const CADENCE_MS = 5_000;
const TRACE = new URL("../../../docs/superpowers/evidence/2026-08-03-ui-redesign/postcheck-c/", import.meta.url).pathname;

test("three attention surfaces spend ONE poller's worth of requests a minute", async ({ page }) => {
  test.skip(process.env.VENDO_POLLER_PROOF !== "1", "60-second measurement — run it explicitly for the trace");
  test.setTimeout(WINDOW_MS + 60_000);

  const asks: number[] = [];
  const started = Date.now();
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/vendo/approvals") asks.push(Date.now() - started);
  });

  await openScenario(page, "attention-surfaces");
  // All three surfaces are mounted and reading the same one ask.
  await expect(page.getByRole("region", { name: /Needs you — 1 waiting/ })).toBeVisible();
  await expect(page.getByText("Waiting on you · 1")).toBeVisible();
  await expect(page.getByRole("button", { name: /AI agent/ })).toBeVisible();

  await page.waitForTimeout(WINDOW_MS);

  const ticks = WINDOW_MS / CADENCE_MS;
  const perSurface = ticks + 1;
  await mkdir(TRACE, { recursive: true });
  await writeFile(
    `${TRACE}approvals-poller-trace.txt`,
    [
      "GET /approvals over 60s — /attention-surfaces (center page + overlay launcher)",
      `surfaces mounted: ${SURFACES} (launcher badge, waiting strip, rail needs-you) @ ${CADENCE_MS}ms each`,
      `one poller costs:  ~${perSurface} requests`,
      `three pollers cost: ~${perSurface * SURFACES} requests (the behaviour this round replaced)`,
      `measured:           ${asks.length} requests`,
      "",
      `request offsets (ms): ${asks.join(", ")}`,
      "",
    ].join("\n"),
    "utf8",
  );

  // One poller, with a tick of slack for the mount fetch and scheduling jitter.
  expect(asks.length).toBeLessThanOrEqual(perSurface + 2);
  // …and it really is polling (a dead poller would also be "few requests").
  expect(asks.length).toBeGreaterThanOrEqual(ticks - 2);
});
