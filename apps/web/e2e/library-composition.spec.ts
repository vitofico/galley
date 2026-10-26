import { test, expect } from "@playwright/test";
import { skipDemoSeed } from "./app-helpers.js";

test("project desk has cover cards and keyboard-safe actions without losing CRUD", async ({
  page,
}) => {
  await skipDemoSeed(page);
  await page.goto("/library");
  await expect(page.getByTestId("library-empty")).toBeVisible();
  const primary = page.getByTestId("library-new-from-template");
  const search = page.getByTestId("library-search");
  expect(
    await primary.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  for (const name of [
    "Annus Mirabilis",
    "Research notes",
    "Quarterly report",
  ]) {
    await page.getByTestId("new-project-tile").click();
    await page.getByTestId("new-project-name").fill(name);
    await page.getByTestId("create-project").click();
    await expect(
      page.locator('[data-testid="project-card"]', { hasText: name }),
    ).toBeVisible();
  }
  await expect(page.getByTestId("project-card")).toHaveCount(3);
  await expect(page.locator(".library-cover")).toHaveCount(3);
  await expect(page.locator(".library-card-meta").first()).toContainText(
    "Edited",
  );
  const card = page
    .getByTestId("project-card")
    .filter({ hasText: "Research notes" });
  await expect(card.getByTestId("delete-project")).toHaveCount(0);
  await card.getByTestId("project-menu").click();
  await card.getByTestId("rename-project").click();
  const rename = card.getByTestId("rename-project-input");
  await rename.fill("Field notes");
  await rename.press("Enter");
  const renamed = page
    .getByTestId("project-card")
    .filter({ hasText: "Field notes" });
  await expect(renamed.locator(".library-card-name")).toHaveText("Field notes");
  await renamed.getByTestId("project-menu").click();
  await page.keyboard.press("Escape");
  await expect(renamed.getByTestId("project-menu")).toBeFocused();
  await expect(renamed.getByTestId("project-menu")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await renamed.getByTestId("project-menu").click();
  await renamed.getByTestId("delete-project").click();
  await expect(renamed.getByTestId("delete-confirm")).toBeVisible();
  await renamed.getByTestId("delete-project-cancel").click();
  await expect(renamed.getByTestId("project-menu")).toBeFocused();
  await expect(renamed).toBeVisible();
  await renamed.getByTestId("project-menu").click();
  await renamed.getByTestId("delete-project").click();
  await renamed.getByTestId("delete-project-confirm").click();
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await search.fill("Quarterly");
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await page.getByTestId("open-project").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("open-library")).toBeVisible({
    timeout: 60_000,
  });
});
