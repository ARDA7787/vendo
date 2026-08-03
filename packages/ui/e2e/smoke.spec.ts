/**
 * The UI smoke pack — the four things that must never silently stop working,
 * and the only browser specs wired into the root gate (`pnpm test` →
 * `turbo run test:ui`).
 *
 * Deliberately shallow and deliberately class-free: it asserts on ROLES and
 * user-visible TEXT, never on `fl-*` internals, so a restyle passes and a
 * "nothing rendered / nothing responds" regression fails. Everything runs off
 * the scripted wire fixture (`test/wire-server.ts`) — no model calls, no
 * network, no clock dependence. Budget: under a minute, single worker.
 *
 * The deep behavioural coverage stays in the full local suite (`test:browser`).
 */
import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

test("landing renders its greeting, suggestions and composer", async ({ page }) => {
  await openScenario(page, "thread-landing");
  await expect(page.getByText("What do you want to build?")).toBeVisible();
  await expect(page.getByRole("button", { name: /What was that \$87 DoorDash charge\?/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("a scripted turn streams assistant text into the transcript", async ({ page }) => {
  await openScenario(page, "composer");
  await page.getByRole("textbox", { name: "Message" }).fill("Say something back");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Turn complete")).toBeVisible({ timeout: 20_000 });
});

test("the approval card approves and reports the decision", async ({ page }) => {
  await openScenario(page, "approval");
  // Humanized, never the raw slug — the consent surface's standing law.
  await expect(page.getByLabel("Approval for Delete invoice")).toBeVisible();
  await expect(page.getByText("host_delete_invoice")).toHaveCount(0);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("approval-recorder")).toHaveText('resolved: {"approve":true}');
});

test("the overlay opens from the launcher and closes on Escape", async ({ page }) => {
  await openScenario(page, "overlay-manual");
  const launcher = page.getByRole("button", { name: "AI agent" });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
});
