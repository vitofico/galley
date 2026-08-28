import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * M7 — a host who hasn't named themselves shares as the generic "Editor", and
 * the optional identity row is easy to miss. When the Share popover opens with
 * no display name set, the name field is auto-focused so the host is nudged to
 * introduce themselves before handing out the link. Once they have a name, the
 * focus is NOT stolen (the link is their next action).
 */
test("Share autofocuses the name field when the host has no display name (M7)", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Fresh local profile → no display name → opening Share focuses the name field.
  await page.getByTestId("share-button").click();
  await expect(page.getByTestId("share-display-name")).toBeFocused();
});

test("Share does NOT steal focus once the host has named themselves (M7)", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Name myself from the popover, then close it by toggling the trigger.
  await page.getByTestId("share-button").click();
  await page.getByTestId("share-display-name").fill("Vito");
  await page.getByTestId("share-display-name-save").click();
  await page.getByTestId("share-button").click(); // toggle closed
  await expect(page.getByTestId("share-display-name")).toHaveCount(0);

  // Reopen: a host WITH a name keeps the old behavior — the name field is not
  // auto-focused (so the autofocus only ever nudges the un-named).
  await page.getByTestId("share-button").click();
  await expect(page.getByTestId("share-display-name")).toHaveValue("Vito");
  await expect(page.getByTestId("share-display-name")).not.toBeFocused();
});
