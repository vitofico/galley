import { test, expect, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * The tabbed layout on a PHONE: a 390px-wide touch screen. Below 820px the
 * three panes become four tabs; these tests pin what makes that layout usable
 * for its phone job, reading the typeset page and answering an agent proposal:
 *
 *   - it opens on the page, and the header/banners never overlap the tabs;
 *   - the controls are finger-sized;
 *   - a proposal survives a tab switch and its Accept button can be reached;
 *   - a zoomed page can be panned to both of its edges, and Fit fills the pane.
 *
 * `hasTouch` is what makes the primary pointer coarse, which is how the shell
 * tells a phone from a narrow desktop window (see `initialPaneTab`).
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const tab = (page: Page, id: string) =>
  page.locator(`[data-testid="tab"][data-tab="${id}"]`);

async function bootPhone(page: Page): Promise<void> {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("tab-bar")).toBeVisible();
}

test("phone: opens on the page, with finger-sized tabs and no overlapping chrome", async ({
  page,
}) => {
  await bootPhone(page);

  // A touch device opens on the typeset page, not the source.
  await expect(tab(page, "preview")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // The "Press ⌘K" hint is keyboard jargon here; the ☰ menu button stands in.
  await expect(page.getByTestId("palette-nudge")).toHaveCount(0);
  await expect(page.getByTestId("palette-button")).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const panel = rect(document.querySelector('[data-testid="tab-panel"]')!);
    const above = [
      ...document.querySelectorAll(".shell-top, .durability-bar, .pending-review-bar"),
    ].map((el) => rect(el).bottom);
    return {
      viewportH: window.innerHeight,
      panelTop: panel.top,
      panelH: panel.height,
      chromeBottom: Math.max(...above),
      tabHeights: [...document.querySelectorAll('[data-testid="tab"]')].map(
        (el) => rect(el).height,
      ),
      pageOverflowsSideways:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  // Header and banners sit ABOVE the tab panel (they used to cover it) …
  expect(geometry.chromeBottom).toBeLessThanOrEqual(geometry.panelTop + 1);
  // … and leave the page at least half the screen, banner included.
  expect(geometry.panelH).toBeGreaterThan(geometry.viewportH / 2);
  for (const h of geometry.tabHeights) expect(h).toBeGreaterThanOrEqual(44);
  expect(geometry.pageOverflowsSideways).toBe(false);
});

test("phone: a proposal survives a tab switch and Accept is reachable", async ({ page }) => {
  await bootPhone(page);

  await tab(page, "agent").click();
  await page.getByTestId("agent-send").click();
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });

  // Flip to the page to look at it, and come back: the agent pane stays mounted,
  // so the unanswered proposal is still there (it used to be discarded).
  await tab(page, "preview").click();
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
  await expect(diff).toBeHidden();
  await tab(page, "agent").click();
  await expect(diff).toBeVisible();

  // The chat owns a real share of the screen (it was squeezed to one line, with
  // Accept/Reject clipped out of it) and the buttons are finger-sized.
  const accept = page.getByTestId("accept");
  await accept.scrollIntoViewIfNeeded();
  const sizes = await page.evaluate(() => ({
    transcript: document.querySelector(".agent-transcript")!.getBoundingClientRect().height,
    accept: document.querySelector('[data-testid="accept"]')!.getBoundingClientRect().height,
    reject: document.querySelector('[data-testid="reject"]')!.getBoundingClientRect().height,
  }));
  expect(sizes.transcript).toBeGreaterThan(200);
  expect(sizes.accept).toBeGreaterThanOrEqual(44);
  expect(sizes.reject).toBeGreaterThanOrEqual(44);

  await accept.click();
  await expect(diff).toHaveCount(0);
  await tab(page, "editor").click();
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Inserted by the Galley demo agent.",
  );
});

test("phone: a zoomed page pans to both edges, and Fit fills the pane", async ({ page }) => {
  await bootPhone(page);
  const preview = page.getByTestId("preview");
  await expect(preview.locator("svg").first()).toBeVisible();

  // Park the pointer on the pill so its idle fade cannot swallow a click (same
  // reason as the Fit test in preview.spec.ts).
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const box = (await zoomIn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 1);
  for (let i = 0; i < 4; i++) await zoomIn.click();
  await expect(page.getByTestId("preview-zoom-level")).toHaveText("200%");

  const edges = (scrollTo: "start" | "end") =>
    preview.evaluate((el, where) => {
      el.scrollLeft = where === "start" ? 0 : el.scrollWidth;
      const pane = el.getBoundingClientRect();
      const page = el.querySelector("svg")!.getBoundingClientRect();
      return { paneLeft: pane.left, paneRight: pane.right, left: page.left, right: page.right };
    }, scrollTo);
  // The zoomed page is wider than the pane …
  const atStart = await edges("start");
  expect(atStart.right - atStart.left).toBeGreaterThan(atStart.paneRight - atStart.paneLeft);
  // … its left edge is inside the pane when scrolled to the start (it used to
  // hang off the left, out of the scroll range) …
  expect(atStart.left).toBeGreaterThanOrEqual(atStart.paneLeft);
  // … and its right edge is inside the pane when scrolled to the end.
  const atEnd = await edges("end");
  expect(atEnd.right).toBeLessThanOrEqual(atEnd.paneRight + 1);

  // Fit: the A4 page is wider than a phone, so fitting it IS the 100% view,
  // and the page fills the pane's content width (it used to shrink to ~60%).
  await page.getByRole("button", { name: "Fit width" }).click();
  await expect(page.getByTestId("preview-zoom-level")).toHaveText("100%");
  const fitted = await preview.evaluate((el) => {
    const cs = getComputedStyle(el);
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { avail, page: el.querySelector("svg")!.getBoundingClientRect().width };
  });
  expect(Math.abs(fitted.page - fitted.avail)).toBeLessThanOrEqual(2);
});
