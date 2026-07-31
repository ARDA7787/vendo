/**
 * Wave-1 FIX-WAVE browser proof — the two user-visible fixes, in a real browser.
 *
 * P1 (bug 2) the consent card's money row: a cents-denominated amount must read
 * as money, not as the integer a person misreads by 100×.
 * P2 (bug 3) the progress chip: Vendo's own tools must narrate with a title, not
 * with their identifier prettified into words ("Vendo apps edit…").
 *
 * Drives the REAL demo (apps/demo-bank) with MAPLE_HARNESS UNSET — which is also
 * the cleanup criterion: the proof scaffolding is off and the shipped demo
 * behaves as it always did.
 *
 *   PORT=3213 MAPLE_DIST_DIR=.next/wave1-fixproof bash docs/verification/wave1-live/run-maple-harness.sh
 *   node docs/verification/wave1-live/probes/fixwave-browser-proof.mjs
 */
import { chromium } from "/Users/yousefh/orca/workspaces/flowlet/format/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/index.mjs";
import { mkdir } from "node:fs/promises";

const BASE = process.env.PROOF_BASE ?? "http://127.0.0.1:3213";
const SHOTS = "/Users/yousefh/orca/workspaces/flowlet/format/docs/verification/wave1-live/screenshots";
const TRANSFER = "Move money to savings";
const APP_BUILD = "Build me a subscriptions tracker";

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const findings = {};

/** Click a landing card / chip, exactly as a person opens the demo and taps. */
const tap = async (label) => {
  const button = page.getByRole("button").filter({ hasText: label }).first();
  await button.waitFor({ timeout: 60_000 });
  await button.click();
};

try {
  await page.goto(`${BASE}/vendo`, { waitUntil: "domcontentloaded", timeout: 90_000 });

  // ---- P1: the money consent card -----------------------------------------
  await tap(TRANSFER);
  // The IN-THREAD card. Scoped to the conversation on purpose: it synthesizes its
  // descriptor (`inputSchema: {}`) because the wire approval part carries none, so
  // it is the surface that exercises the undeclared-unit branch.
  const threadCard = page.locator(".fl-thread .fl-approval").first();
  await threadCard.waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  findings.threadCardText = (await threadCard.innerText()).replace(/\s+/g, " ");
  await threadCard.screenshot({ path: `${SHOTS}/fix-e2c-consent-card-in-thread.png` });

  // The QUEUE card renders the real server record — descriptor and declared
  // input schema included, which is what the money rule reads.
  await page.goto(`${BASE}/vendo`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const queue = page.locator("section[aria-label='Vendo activity'] .fl-approval").first();
  await queue.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  findings.queueCardText = (await queue.innerText()).replace(/\s+/g, " ");
  await queue.screenshot({ path: `${SHOTS}/fix-e2c-consent-card-real-args.png` });
  await page.screenshot({ path: `${SHOTS}/fix-e2c-consent-page.png`, fullPage: false });

  // ---- P2: the progress chip for one of Vendo's OWN tools ------------------
  const chip = await page.goto(`${BASE}/vendo`, { waitUntil: "domcontentloaded", timeout: 90_000 }).then(() => true);
  if (chip) {
    await tap(APP_BUILD);
    const labels = new Set();
    const deadline = Date.now() + 180_000;
    let shot = false;
    while (Date.now() < deadline) {
      const ribbon = page.locator(".fl-ribbon").first();
      if (await ribbon.count() > 0) {
        const tool = await ribbon.getAttribute("data-vendo-tool").catch(() => null);
        const text = await ribbon.innerText().catch(() => "");
        if (text) labels.add(`${tool ?? "?"} → ${text.replace(/\s+/g, " ")}`);
        if (!shot && tool?.startsWith("vendo_apps")) {
          await page.screenshot({ path: `${SHOTS}/fix-e1-5-progress-chip-title.png` });
          shot = true;
        }
      }
      const beats = await page.locator(".fl-beat").all();
      for (const beat of beats) {
        const tool = await beat.getAttribute("data-vendo-tool").catch(() => null);
        const text = await beat.innerText().catch(() => "");
        if (text) labels.add(`${tool ?? "?"} → ${text.replace(/\s+/g, " ")}`);
      }
      if (shot && (await page.locator(".fl-tree, [data-vendo-app]").count()) > 0) break;
      await page.waitForTimeout(400);
    }
    findings.progressLabels = [...labels];
    findings.chipScreenshot = shot;
    await page.screenshot({ path: `${SHOTS}/fix-e1-5-after-app-turn.png`, fullPage: false });
    findings.activityText = await page
      .locator(".fl-act-row, .fl-activity-row")
      .allInnerTexts()
      .then((rows) => rows.slice(0, 10).map((row) => row.replace(/\s+/g, " ")))
      .catch(() => []);
  }
} catch (error) {
  findings.error = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: `${SHOTS}/fix-proof-failure.png` }).catch(() => undefined);
} finally {
  console.log(JSON.stringify(findings, null, 2));
  await browser.close();
}
