import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * L10 — the project-name pill in the header is click-to-rename, but at rest it
 * reads as plain text; previously the only hint was the `title` tooltip (which
 * needs a hover dwell). It now shows an IMMEDIATE underline + pencil affordance
 * on hover/focus, so the rename is discoverable without waiting for the tooltip.
 * The rest state stays deliberately quiet (the shipped design), so this asserts
 * the cue on hover, not at rest.
 */
test("L10: the project-name pill shows an editable cue on hover", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const pill = page.getByTestId("project-name");
  await expect(pill).toBeVisible();
  // It's the renameable role="button" variant (click-to-rename is wired).
  await expect(pill).toHaveAttribute("role", "button");

  // Rest: quiet (no underline) — honoring the "quiet until hover" design.
  const restDeco = await pill.evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(restDeco).not.toContain("underline");

  // Hover: an immediate underline cue appears (the editable affordance).
  await pill.hover();
  await expect
    .poll(() => pill.evaluate((el) => getComputedStyle(el).textDecorationLine))
    .toContain("underline");
});
