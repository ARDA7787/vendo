import { chromium } from "/Users/yousefh/orca/workspaces/flowlet/wave3-stage/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const ROOT = "/Users/yousefh/orca/workspaces/flowlet/wave3-stage";
const OUT = `${ROOT}/docs/superpowers/evidence/2026-08-02-wave3-b1`;
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:3122";

const browser = await chromium.launch({ headless: true });
const shot = async (page, name, focus) => {
  if (focus !== undefined) {
    await page.locator(focus).first().scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log("shot:", name);
};

async function signIn(context, email) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto(`${BASE}/login?returnTo=%2Fvendo%2Fworkspace`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "maple-demo");
  await Promise.all([
    page.waitForURL(/vendo\/workspace|\/$/, { timeout: 60000 }),
    page.click('button[type="submit"]'),
  ]);
  return page;
}

const openApps = async (page) => {
  await page.click('role=tab[name="Apps"]');
  await page.waitForTimeout(1500);
};

const card = (page, name) => page.locator("article").filter({ hasText: name }).first();
/** The ONE open Share dialog. Everything is scoped to it: "Share" is also the
    label on every card's own button, so an unscoped click is a coin toss. */
const dialog = (page) => page.locator(".fl-share");

const grantsOf = async (page, appId) => await page.evaluate(async (id) => {
  const response = await fetch(`/api/vendo/apps/${id}/grants`, { headers: { accept: "application/json" } });
  return { status: response.status, body: await response.json() };
}, appId);

const results = [];
const record = (name, value) => { console.log(`\n### ${name}\n${JSON.stringify(value, null, 2)}`); results.push([name, value]); };

// ---------------------------------------------------------------- Yousef ----
const ctx = await browser.newContext();
const yousef = await signIn(ctx, "yousef@maple.com");
await yousef.waitForTimeout(2000);
await openApps(yousef);
await shot(yousef, "00-apps-tab");

// ---- B1-1: the option exists, the host names the person, the grant is theirs
await card(yousef, "Team pulse").getByRole("button", { name: "Share" }).click();
await yousef.waitForTimeout(800);
const picker = dialog(yousef).getByLabel("Who to share with");
record("picker options (resolvePerson WIRED)", await picker.locator("option").allTextContents());
await picker.selectOption({ label: "A specific person…" });
await yousef.waitForTimeout(400);
await shot(yousef, "01-person-field-look-them-up");

await dialog(yousef).getByLabel("Look them up by name or email").fill("mia");
await shot(yousef, "02-typed-a-first-name");
await dialog(yousef).getByRole("button", { name: "Share" }).click();
await yousef.waitForTimeout(2500);
await shot(yousef, "03-moved-and-shared-with-the-resolved-person", ".fl-share");
record("pulse grants after the person-share", await grantsOf(yousef, "app_b1_pulse"));
record("statuses on screen", await dialog(yousef).locator('[role="status"]').allTextContents());
record("share list rows", await dialog(yousef).locator(".fl-share-row").allTextContents());

// ---- B1-2: a name the host does not know moves NOTHING and grants NOTHING
await dialog(yousef).getByRole("button", { name: "Done" }).click();
await yousef.waitForTimeout(500);
await card(yousef, "Desk ledger").getByRole("button", { name: "Share" }).click();
await yousef.waitForTimeout(1200);
record("dialog now open on", await dialog(yousef).locator(".fl-share-title").innerText());
record("ledger BEFORE (personal?)", await grantsOf(yousef, "app_b1_ledger"));
await dialog(yousef).getByLabel("Who to share with").selectOption({ label: "A specific person…" });
await dialog(yousef).getByLabel("Look them up by name or email").fill("Mia from the other bank");
await dialog(yousef).getByRole("button", { name: "Share" }).click();
await yousef.waitForTimeout(2500);
await shot(yousef, "04-unknown-person-refused-nothing-moved", ".fl-share-error");
record("refusal alert", await dialog(yousef).locator(".fl-share-error").allTextContents());
record("ledger AFTER the refused person-share", await grantsOf(yousef, "app_b1_ledger"));

// ---- B1-3: a host with NO directory does not offer the option at all -------
// The seam is read per request at composition, so this context intercepts
// /api/vendo/status and strips `namesPeople` — exactly what an unwired host
// answers. The SERVER half (501 + the flag absent) is proven over the real
// composition in packages/vendo/src/orgs-e8.test.ts.
const noDir = await browser.newContext();
await noDir.route("**/api/vendo/status", async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  delete body.namesPeople;
  await route.fulfill({ response, json: body });
});
const undirectoried = await signIn(noDir, "yousef@maple.com");
await undirectoried.waitForTimeout(2000);
await openApps(undirectoried);
await card(undirectoried, "Quarter close").getByRole("button", { name: "Share" }).click();
await undirectoried.waitForTimeout(800);
record(
  "picker options (resolvePerson UNSET)",
  await dialog(undirectoried).getByLabel("Who to share with").locator("option").allTextContents(),
);
await shot(undirectoried, "05-no-directory-no-person-option", ".fl-share");

// ---- B1-4: the page speaks the consumer's voice for a refusal --------------
// Yousef removes "Rate watch" in one tab; the other tab's list is stale, so its
// Remove hits an app that is gone — a real not-found, the kind whose developer
// sentence ("app not found: app_b1_stale") used to be the copy on screen.
const stale = await ctx.newPage();
await stale.setViewportSize({ width: 1440, height: 980 });
await stale.goto(`${BASE}/vendo/workspace`, { waitUntil: "domcontentloaded" });
await stale.waitForTimeout(2000);
await openApps(stale);
stale.on("dialog", (dialog) => void dialog.accept());
yousef.on("dialog", (dialog) => void dialog.accept());
await card(yousef, "Rate watch").getByRole("button", { name: "Remove" }).click();
await yousef.waitForTimeout(2000);
await card(stale, "Rate watch").getByRole("button", { name: "Remove" }).click();
await stale.waitForTimeout(2000);
await shot(stale, "06-page-refusal-in-consumer-voice", ".fl-error");
record("page alert for a vanished app", await stale.locator(".fl-error").allTextContents());

console.log("\n=== SUMMARY ===");
for (const [name, value] of results) console.log(`${name}: ${JSON.stringify(value)}`);
await browser.close();
