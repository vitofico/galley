import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Activation e2e for the authoring + ergonomics cluster — the coordinator sweep
 * that wires the parallel-built, default-off slices into the single-file shell:
 *   - #11.2 preview zoom (toolbar in the preview)
 *   - #12.7 document stats + click-to-jump outline
 *   - #11.8d token/cost meter (estimated)
 *   - #11.5 find/replace panel (Mod-f)
 *   - #13 cross-reference `@`-label autocomplete (#6 cite keys share the menu)
 * Each is asserted to be USER-REACHABLE, not merely present in the bundle.
 */

test("ergonomics surfaces are live: zoom, stats+outline jump, cost meter, find", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // #11.2 — preview zoom: starts at 100% with no transform; zooming in scales.
  await expect(page.getByTestId("preview-zoom-level")).toHaveText("100%");

  // Layout guard: at 100% the document FITS the pane — no horizontal overflow
  // (a flex-row .preview once laid the zoom toolbar BESIDE the page, pushing
  // the document off the pane edge).
  const preview = page.getByTestId("preview");
  const overflowX = await preview.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflowX).toBeLessThanOrEqual(1);
  // #19.3: the zoom controls are a floating BOTTOM-CENTER pill over the
  // preview pane (it auto-fades when idle — see consolidation.spec.ts). Assert
  // the new placement: horizontally centered in the pane, anchored at its foot.
  const barBox = await page.locator(".preview-zoom-bar").boundingBox();
  const paneBox = await preview.boundingBox();
  expect(barBox && paneBox).toBeTruthy();
  if (barBox && paneBox) {
    const barCenter = barBox.x + barBox.width / 2;
    const paneCenter = paneBox.x + paneBox.width / 2;
    expect(Math.abs(barCenter - paneCenter)).toBeLessThanOrEqual(24);
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1);
    expect(barBox.y).toBeGreaterThan(paneBox.y + paneBox.height / 2);
  }

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByTestId("preview-zoom-level")).not.toHaveText("100%");
  await expect(page.locator('.preview-page[data-zoomed="true"]')).toBeVisible();

  // #12.7 — document metrics live in a slim status strip below the preview;
  // the outline moved behind its toggle (the big center cards were too invasive).
  await expect(page.getByTestId("doc-stats")).toBeVisible();
  await expect(page.getByTestId("doc-stats-words")).toContainText(/\d/);

  // Reveal the outline from the status strip, then confirm it lists a heading.
  await page.getByTestId("rail-outline").click();
  const outlineItems = page.getByTestId("doc-outline-item");
  await expect(outlineItems.first()).toBeVisible();

  // Clicking an outline heading jumps into (and focuses) the editor.
  await outlineItems.first().click();
  await expect(page.locator('[data-testid="editor"] .cm-editor.cm-focused')).toBeVisible();

  // #11.8d — the token/cost meter renders in the agent panel after a run
  // (gated on usage.totalTokens > 0 so it is absent on initial load; the
  // meter is exercised end-to-end in agent-ux.spec.ts via the Demo model).

  // #11.5 — Mod-f opens the find panel inside the editor.
  await page.locator('[data-testid="editor"] .cm-content').click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator('[data-testid="editor"] .cm-panel.cm-search')).toBeVisible();
});

test("cross-reference @-autocomplete offers a label defined in the document (#13)", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  // Define a label <intro>, then start a reference `@in` and ask for completion.
  await page.keyboard.type("= Intro <intro>\n\nSee @in");
  await page.keyboard.press("Control+Space");

  // The completion menu offers the known label name.
  const menu = page.locator(".cm-tooltip-autocomplete");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu).toContainText("intro");
});
