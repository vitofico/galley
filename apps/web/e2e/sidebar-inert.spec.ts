import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * M16 — the agent sidebar collapses to `0fr` (stays in the DOM) on a wide layout.
 * `aria-hidden` hid it from assistive tech but did NOT block focus, so a keyboard
 * user could Tab into the invisible pane. It is now `inert` when collapsed, which
 * both removes it from the a11y tree and blocks focus/pointer on its controls.
 */
const hasInert = (page: import("@playwright/test").Page, sel: string) =>
  page.locator(sel).evaluate((el) => el.hasAttribute("inert"));

test("M16: the agent sidebar is inert only while collapsed (wide layout)", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const sel = 'aside[aria-label="AI agent"]';
  await expect(page.locator(sel)).toBeVisible();

  // Open by default → NOT inert (its controls are reachable).
  expect(await hasInert(page, sel)).toBe(false);
  await expect(page.getByTestId("collapse-sidebar")).toBeVisible();

  // Collapse the agent panel → the pane is inert (focus/pointer blocked).
  await page.getByTestId("collapse-sidebar").click();
  await expect.poll(() => hasInert(page, sel)).toBe(true);

  // A focusable control inside the collapsed pane can no longer take focus — the
  // browser blocks `.focus()` on an inert subtree (and blurs any descendant that
  // already held focus), so it stays off that button. Poll rather than assert
  // once: when `inert` flips, the browser settles focus asynchronously, so a
  // single read can race the blur (a suite-position flake, CX-4).
  await page
    .locator(`${sel} [data-testid="collapse-sidebar"]`)
    .evaluate((el) => (el as HTMLElement).focus());
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null),
    )
    .not.toBe("collapse-sidebar");
});
