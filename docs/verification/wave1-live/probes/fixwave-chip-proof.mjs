/**
 * Wave-1 FIX-WAVE browser proof, part 2 — the progress chip and the in-thread card.
 *
 * The landing chips serve a PRE-GENERATED app (no tool call, so no chip to read),
 * so this types a fresh, unscripted build prompt: a real agent turn that really
 * calls `vendo_apps_create`, which is the tool whose identifier the §3 leak
 * photographed ("Vendo apps edit…" / "Vendo apps create…"). Every ribbon and beat
 * label seen during the turn is recorded, so a slug reaching the screen fails the
 * proof by appearing in the transcript of labels — not by absence of evidence.
 *
 *   node docs/verification/wave1-live/probes/fixwave-chip-proof.mjs
 */
import { chromium } from "/Users/yousefh/orca/workspaces/flowlet/format/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/index.mjs";

const BASE = process.env.PROOF_BASE ?? "http://127.0.0.1:3213";
const SHOTS = "/Users/yousefh/orca/workspaces/flowlet/format/docs/verification/wave1-live/screenshots";
const PROMPT = process.env.PROOF_PROMPT
  ?? "Make me a small card showing my three biggest grocery charges this month.";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const findings = { labels: [], slugLeaks: [] };

try {
  await page.goto(`${BASE}/vendo`, { waitUntil: "domcontentloaded", timeout: 90_000 });

  // The in-thread consent card, scoped to the CONVERSATION (the page also shows
  // the queue card above it, and the two read from different descriptor sources).
  const inThread = page.locator(".fl-thread .fl-approval").first();
  if (await inThread.count() > 0) {
    findings.inThreadCardText = (await inThread.innerText()).replace(/\s+/g, " ");
    await inThread.screenshot({ path: `${SHOTS}/fix-e2c-consent-card-in-thread.png` });
  }

  const box = page.getByRole("textbox", { name: "Message" });
  await box.waitFor({ timeout: 60_000 });
  await box.click();
  await box.pressSequentially(PROMPT, { delay: 8 });
  await page.getByRole("button", { name: "Send", exact: true }).last().click();

  const seen = new Set();
  const deadline = Date.now() + 240_000;
  let shot = false;
  while (Date.now() < deadline) {
    for (const selector of [".fl-ribbon", ".fl-beat"]) {
      for (const node of await page.locator(selector).all()) {
        const tool = await node.getAttribute("data-vendo-tool").catch(() => null);
        const text = await node.innerText().catch(() => "");
        if (!text) continue;
        seen.add(`${selector} ${tool ?? "?"} → ${text.replace(/\s+/g, " ")}`);
        if (!shot && (tool ?? "").startsWith("vendo_")) {
          // The ELEMENT, not the page: the ribbon sits above the composer, and a
          // viewport shot of a long page can miss the very thing being proven.
          await node.scrollIntoViewIfNeeded().catch(() => undefined);
          await node.screenshot({ path: `${SHOTS}/fix-e1-5-progress-chip-title.png` });
          await page.screenshot({ path: `${SHOTS}/fix-e1-5-progress-chip-in-page.png` });
          shot = true;
        }
      }
    }
    if (await page.getByText("Copy", { exact: true }).count() > 0 && shot) break;
    await page.waitForTimeout(300);
  }
  findings.labels = [...seen];
  // A slug on screen is the defect. Any label carrying a `vendo_`/`host_` id or
  // our namespace read out as words fails.
  findings.slugLeaks = findings.labels.filter((label) => {
    const rendered = label.split("→")[1] ?? "";
    return /vendo_|host_|\bVendo apps\b/i.test(rendered);
  });
  findings.chipScreenshot = shot;
  await page.screenshot({ path: `${SHOTS}/fix-e1-5-app-turn-done.png` });
} catch (error) {
  findings.error = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: `${SHOTS}/fix-chip-proof-failure.png` }).catch(() => undefined);
} finally {
  console.log(JSON.stringify(findings, null, 2));
  await browser.close();
}
