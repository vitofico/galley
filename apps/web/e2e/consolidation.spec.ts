import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * #19.3 "Rail & Islands" control consolidation (spec §2) — the acceptance net
 * for the six consolidations: ONE Export menu, ONE status chip (+ popover with
 * the compiler toggle), the Share popover, the auto-fading zoom pill, and the
 * hover/focus-revealed per-row actions (file ops + diagnostic actions).
 *
 * The spec's invariants under test:
 *  - every consolidated function stays reachable in ≤2 interactions;
 *  - revealed-on-hover controls are NEVER hover-only (keyboard focus reveals);
 *  - rubric R8: the always-visible chrome stays at the consolidated budget.
 */

async function settle(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
}

test("R8 budget: the top islands hold exactly the consolidated controls", async ({ page }) => {
  await gotoEditor(page);
  await settle(page);

  // H5: dismiss the one-time first-run chooser cue so we measure the STEADY-STATE
  // budget (it's transient onboarding, like the ⌘K nudge below — gone for good
  // after first use). Once dismissed, the ⌘K nudge takes the slot (excluded too).
  await page.getByTestId("first-run-dismiss").click();

  // Brand pill: wordmark, status chip. Actions pill: Comments, Share, Export, ⌘K.
  // Six buttons total — the export trio, the 3-mode compiler toggle, and the
  // notice spans are gone from the always-visible chrome. Templates moved to the
  // Projects page, so the ⊞ new-from-template button is gone from the editor.
  // (Comments Phase A added the 💬 overview toggle — a single trigger that opens a
  // TRANSIENT popover, not a permanent panel, so it stays within the island budget.)
  // (#19.4: the one-time ⌘K onboarding nudge is excluded from the steady-state
  // budget — it disappears forever the first time the palette opens.)
  await expect(page.locator(".shell-top button:not(.nudge-pill)")).toHaveCount(6);
  await expect(page.getByTestId("compiler-mode-toggle")).toHaveCount(0);
  await expect(page.getByTestId("export-bundle")).toHaveCount(0);
  await expect(page.locator(".share-island")).toHaveCount(0);
});

test("one Export menu: keyboard navigable; items keep their testids; palette covers all three", async ({
  page,
}) => {
  await gotoEditor(page);
  await settle(page);

  // Open with the keyboard (Enter on the trigger) — focus lands on the first item.
  await page.getByTestId("export-menu-button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("export-menu")).toBeVisible();
  await expect(page.getByTestId("export-pdf")).toBeFocused();

  // ↓ walks the items (wrapping is unit-tested in menu-nav.test.ts).
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("export-bundle")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("export-git-repo")).toBeFocused();

  // Escape closes and returns focus to the trigger (a11y contract).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("export-menu")).toHaveCount(0);
  await expect(page.getByTestId("export-menu-button")).toBeFocused();

  // The palette reaches all three exports too (spec: palette covers everything).
  await page.getByTestId("palette-button").click();
  await page.getByTestId("command-palette-input").fill("export");
  for (const id of ["export-pdf", "export-bundle", "export-git-repo"]) {
    await expect(
      page.locator(`[data-testid="command-palette-item"][data-command-id="${id}"]`),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
});

test("unified status chip: details + the compiler toggle live in its popover; Esc returns focus", async ({
  page,
}) => {
  await gotoEditor(page);
  await settle(page);

  // The chip carries the always-visible readouts (status + save-state inside it).
  const chip = page.getByTestId("status-chip");
  await expect(chip).toBeVisible();
  await expect(chip.getByTestId("status")).toHaveText(/page\(s\)/);
  await expect(chip.getByTestId("save-state")).toBeVisible();

  // Click → the popover spells out the details AND hosts the compiler toggle
  // (still ≤2 interactions to any compile mode: chip → mode).
  await chip.click();
  const popover = page.getByTestId("status-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId("compiler-mode-toggle")).toBeVisible();

  // The calm resting backup cue lives in the Save row — a quiet reminder that
  // local-first work lives only here, with a one-click "Export a copy".
  await expect(popover.getByTestId("status-backup-cue")).toBeVisible();
  const download = page.waitForEvent("download");
  await popover.getByTestId("status-backup-export").click();
  await download; // the source bundle export fired…
  await expect(page.getByTestId("status-popover")).toHaveCount(0); // …and closed the popover

  // Escape closes and returns focus to the chip.
  await chip.click();
  await expect(page.getByTestId("status-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-popover")).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test("zoom pill: auto-fades when idle, wakes on pointer movement, never fades while focused", async ({
  page,
}) => {
  await gotoEditor(page);
  await settle(page);

  const pill = page.locator(".preview-zoom-bar");
  await expect(pill).toHaveCount(1);

  // Idle (~1.5s without preview pointer/scroll activity) → it fades out and
  // stops intercepting pointer events (rubric R7: chrome never occludes).
  await expect(pill).toHaveAttribute("data-idle", "true", { timeout: 10_000 });
  await expect(pill).toHaveCSS("pointer-events", "none");

  // Pointer movement over the preview wakes it (synchronously).
  const paneBox = await page.getByTestId("preview").boundingBox();
  if (!paneBox) throw new Error("no preview box");
  await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
  await page.mouse.move(paneBox.x + paneBox.width / 2 + 8, paneBox.y + paneBox.height / 2);
  await expect(pill).not.toHaveAttribute("data-idle", "true");

  // Keyboard: focus suspends the fade — the pill never disappears under a
  // keyboard user (revealed chrome is never hover-only).
  await pill.getByRole("button", { name: "Zoom in" }).focus();
  await page.waitForTimeout(2200);
  await expect(pill).not.toHaveAttribute("data-idle", "true");
});

test("file-row ops reveal on row hover AND on keyboard focus (never hover-only)", async ({
  page,
}) => {
  await gotoEditor(page);
  await settle(page);
  await openFilesDock(page);

  const ops = page.locator(".project-file-row .project-file-ops").first();
  const opacity = () => ops.evaluate((el) => getComputedStyle(el).opacity);

  // Resting: hidden (opacity 0) but still in layout and tabbable.
  await expect.poll(opacity).toBe("0");

  // Hovering the row reveals the ops.
  await page.getByTestId("project-file").first().hover();
  await expect.poll(opacity).toBe("1");

  // Park the pointer away → hidden again; keyboard focus re-reveals.
  await page.mouse.move(5, 5);
  await expect.poll(opacity).toBe("0");
  await page.locator('[data-testid="rename-file"]').first().focus();
  await expect.poll(opacity).toBe("1");
});

test("diagnostic actions (Fix / Explain) reveal on row hover and on keyboard focus", async ({
  page,
}) => {
  await gotoEditor(page);
  await settle(page);

  // Author a located error so the quick-fix/explain actions are offered.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n\n#undefined_var");
  await expect(page.getByTestId("status")).toContainText(/error/i, { timeout: 30_000 });

  const fix = page.getByTestId("quick-fix").first();
  await expect(fix).toBeVisible({ timeout: 30_000 });
  const opacity = () => fix.evaluate((el) => getComputedStyle(el).opacity);

  // Resting: hidden; hovering the diagnostic row reveals.
  await page.mouse.move(5, 5);
  await expect.poll(opacity).toBe("0");
  await page.getByTestId("diagnostic").first().hover();
  await expect.poll(opacity).toBe("1");

  // Keyboard: tabbing onto the action reveals it (focus-within on the row).
  await page.mouse.move(5, 5);
  await expect.poll(opacity).toBe("0");
  await fix.focus();
  await expect.poll(opacity).toBe("1");
});
