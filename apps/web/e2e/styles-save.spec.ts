import { test, expect } from "@playwright/test";

/**
 * Save-your-own style (styles Phase 2) — capture the project's current
 * `/style.typ` as a NAMED local style, see it in the picker as a non-builtin
 * card, then delete it.
 *
 * Deterministic by construction (no flaky editor typing): the `?seed=einstein`
 * demo ships a conforming `/style.typ`, so "Save current style…" has real source
 * to capture. The name prompt is answered via a `page.on("dialog")` handler, and
 * the assertions are pure card-count / data-attribute checks — no compile-text
 * dependency. The store round-trip + capability derivation are proven offline by
 * `local-styles.test.ts`; this is the user-facing wiring proof.
 */
test("Save-your-own: capture the current style, see it as a card, delete it", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Open the Style Library via the command palette.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Change style");
  await page.getByTestId("command-palette-item").first().click();

  const dialog = page.getByTestId("style-library");
  await expect(dialog).toBeVisible();
  // Baseline: just the four built-ins, none deletable.
  await expect(page.getByTestId("style-card")).toHaveCount(4);
  await expect(page.getByTestId("style-delete")).toHaveCount(0);

  // Answer the name prompt deterministically, then click "Save current style…".
  page.once("dialog", (d) => d.accept("My Saved Style"));
  await page.getByTestId("style-save").click();

  // A fifth, non-builtin card appears with the chosen name and a delete control.
  await expect(page.getByTestId("style-card")).toHaveCount(5);
  const savedCard = page
    .getByTestId("style-card")
    .filter({ hasText: "My Saved Style" });
  await expect(savedCard).toHaveCount(1);
  await expect(savedCard).toHaveAttribute("data-builtin", "false");
  await expect(page.getByTestId("style-delete")).toHaveCount(1);

  // Reload proves persistence: the saved style survives and re-renders.
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Change style");
  await page.getByTestId("command-palette-item").first().click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("style-card")).toHaveCount(5);

  // Delete it → back to the four built-ins.
  await page.getByTestId("style-delete").click();
  await expect(page.getByTestId("style-card")).toHaveCount(4);
  await expect(page.getByTestId("style-delete")).toHaveCount(0);
});
