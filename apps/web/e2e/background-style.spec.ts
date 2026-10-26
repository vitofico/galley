import { test, expect } from "@playwright/test";

test("background choice persists independently of colour and mode", async ({
  page,
}) => {
  await page.goto("/settings#appearance");
  await expect(page.getByTestId("settings-background-artwork")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page
      .getByTestId("settings-background-artwork")
      .locator(".background-preview"),
  ).toBeVisible();
  await page.getByTestId("settings-background-plain").click();
  await page.getByTestId("settings-skin-press").click();
  await page.getByTestId("settings-theme-dark").click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-background-style",
    "plain",
  );
  await expect(page.locator("html")).toHaveAttribute("data-skin", "press");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("settings-background-plain")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("settings-background-artwork").click();
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible();
  const art = await page
    .getByTestId("library")
    .evaluate((el) => getComputedStyle(el, "::before").backgroundImage);
  expect(art).toContain("paper-strata.webp");
  await page.goto("/settings");
  await page.getByTestId("settings-background-plain").click();
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible();
  const plain = await page
    .getByTestId("library")
    .evaluate((el) => getComputedStyle(el, "::before").content);
  expect(plain).toBe("none");
});
