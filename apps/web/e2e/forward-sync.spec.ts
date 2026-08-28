import { test, expect } from "@playwright/test";

/**
 * Forward sync (#11.3): editor cursor -> preview scroll + highlight.
 *
 * The companion of the inverse-sync test in inverse-sync-export.spec.ts. Where
 * that proves preview-click -> cursor, this proves cursor-move -> preview
 * highlight, and crucially that the highlight TRACKS the cursor (moves when the
 * cursor moves to a different content line) rather than being a one-shot.
 *
 * Implementation it exercises (none of which this test may modify):
 *   - Editor.tsx fires `onCursorChange` on every selection/doc change.
 *   - ProjectApp.tsx feeds that into Preview as `activeSourcePos`.
 *   - Preview.tsx renders `[data-testid="preview-source-highlight"]` (an
 *     absolutely-positioned div with a ~0.12s CSS transition) ONLY when
 *     `lookupPreviewRegion(sourceMap, activeSourcePos)` resolves to a region.
 *
 * Pre-condition: the forward source map must be present. The default `/` boot
 * compiles the seed sample on the local worker route (requestSourceMap: true),
 * surfaced as `.preview-page[data-source-clickable="true"]` — the same gate the
 * inverse-sync test relies on.
 */

test("editor cursor drives — and tracks — the preview highlight (#11.3 forward sync)", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");

  // Project shell up + a real WASM render of the seed sample.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await expect(
    page.locator('[data-testid="preview"] svg').first(),
  ).toBeVisible();

  // Pre-condition: the forward source map is present (the worker route built it).
  // `data-source-clickable="true"` on the preview page is its observable signal.
  // (.first(): the multi-page demo workspace renders several .preview-page's.)
  const previewPage = page.locator('[data-testid="preview"] .preview-page').first();
  await expect(previewPage).toHaveAttribute("data-source-clickable", "true", {
    timeout: 60_000,
  });

  // Focus the editor and place the cursor on a content-bearing line. The seed
  // `/main.typ` is the "Annus Mirabilis" demo cover sheet (#20.2): ~30 lines of
  // comments and #set/#show rules, then the rendered cover block — the first
  // content-bearing lines ("BERN · KRAMGASSE 49 · 1905" / "Annus Mirabilis" at
  // lines ~33-35), which map to regions on page 1.
  // We do NOT switch files (a file swap remounts the editor and clears cursorPos).
  const content = page.locator('[data-testid="editor"] .cm-content');
  await content.click();
  // Home: jump to the very top so the line offset below is deterministic.
  await page.keyboard.press("ControlOrMeta+Home");
  // Descend past the preamble into the rendered cover block (line ~33); the
  // poll below keeps nudging downwards until a line resolves to a region.
  for (let i = 0; i < 32; i++) await page.keyboard.press("ArrowDown");

  // The highlight must appear. `toBeVisible` with a generous timeout absorbs the
  // ~0.12s CSS transition AND any cursor line that didn't immediately resolve to
  // a region — we retry the cursor downwards until a region is found.
  const highlight = page.locator('[data-testid="preview-source-highlight"]');
  await expect
    .poll(
      async () => {
        if (await highlight.count()) return true;
        // Nudge the cursor down a line and let the region resolve.
        await content.click();
        await page.keyboard.press("ArrowDown");
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(highlight).toBeVisible({ timeout: 3_000 });

  // Capture the highlight's geometry at this cursor position. `style.top` is set
  // directly from the resolved region rect (region.rect.y), so it's the most
  // direct observable of WHICH region the highlight covers.
  const readTop = () =>
    highlight.evaluate((el) => (el as HTMLElement).style.top);
  const firstTop = await readTop();
  expect(firstTop).toBeTruthy();

  // Now move the cursor to a DIFFERENT content line further down the document
  // (the body paragraph), and assert the highlight relocates — proving it tracks
  // the cursor rather than being pinned to the first resolved region. We drive
  // the cursor to the end of the doc, then poll for a top that differs from the
  // first, retrying upward through content lines until a different region maps.
  await content.click();
  await page.keyboard.press("ControlOrMeta+End");

  await expect
    .poll(
      async () => {
        if (!(await highlight.count())) {
          await content.click();
          await page.keyboard.press("ArrowUp");
          return null;
        }
        const top = await readTop();
        if (top === firstTop) {
          // Same region — step the cursor up a line and try again.
          await content.click();
          await page.keyboard.press("ArrowUp");
        }
        return top;
      },
      { timeout: 15_000 },
    )
    .not.toBe(firstTop);

  // And it's still a real, visible overlay after tracking (not collapsed away).
  await expect(highlight).toBeVisible({ timeout: 3_000 });
});

test("the highlight sits ON its content — forward↔inverse round-trip (#11.3)", async ({
  page,
}) => {
  // Regression for the physical-size coordinate bug: the rendered SVG is sized in
  // physical CSS px (Typst point × 96/72) while the source-map rects are in points.
  // If the forward overlay is placed at RAW points (the bug), it lands ~75% up the
  // page — visibly off, and clicking it resolves (via inverse sync) to a far-earlier
  // line. This test composes forward (cursor→highlight) with inverse (click→cursor):
  // clicking the highlight's own center MUST land the editor back on ~the same line.
  await page.goto("/?seed=einstein");

  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await expect(
    page.locator('[data-testid="preview"] svg').first(),
  ).toBeVisible();
  const previewPage = page
    .locator('[data-testid="preview"] .preview-page')
    .first();
  await expect(previewPage).toHaveAttribute("data-source-clickable", "true", {
    timeout: 60_000,
  });

  // DOM index of the active editor line — a focus-robust proxy for the selection
  // head (CM marks it .cm-activeLine; the inverse handler re-focuses the editor).
  const activeLineIndex = () =>
    page.evaluate(() => {
      const content = document.querySelector(
        '[data-testid="editor"] .cm-content',
      );
      if (!content) return -1;
      const lines = Array.from(content.querySelectorAll(".cm-line"));
      const active = content.querySelector(".cm-line.cm-activeLine");
      return active ? lines.indexOf(active) : -1;
    });

  // Park on the abstract's body prose (main.typ lines ~17-25). Real prose whose
  // glyphs carry main.typ source spans, so forward (cursor→region) and inverse
  // (click→cursor) are mutual inverses there. (The cover title/eyebrow are drawn by
  // the imported /style.typ and carry no main.typ leaves; the `#include` lines below
  // resolve into OTHER files — neither round-trips against a main.typ cursor.)
  const content = page.locator('[data-testid="editor"] .cm-content');
  const highlight = page.locator('[data-testid="preview-source-highlight"]');
  await content.click();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowDown");
  await expect
    .poll(
      async () => {
        if (await highlight.count()) return true;
        await content.click();
        await page.keyboard.press("ArrowDown");
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(highlight).toBeVisible({ timeout: 3_000 });

  const baseline = await activeLineIndex();
  expect(baseline).toBeGreaterThanOrEqual(0);

  // Click the HIGHLIGHT's own on-screen center. The overlay is pointer-events:none
  // (CSS), so the click passes THROUGH to the glyph underneath at that point —
  // exactly the content the highlight claims to mark.
  const box = await highlight.boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.click(cx, cy);

  // Round-trip identity (within tolerance for run-vs-line / multi-leaf-per-line
  // noise): clicking the highlight returns the cursor to ~its origin line. With the
  // raw-point bug the highlight floats far off its line, so the click would land
  // many lines away and blow past this tolerance.
  await expect
    .poll(async () => Math.abs((await activeLineIndex()) - baseline), {
      timeout: 15_000,
    })
    .toBeLessThanOrEqual(4);
});

test("the forward highlight tracks its content at any preview width (#11.3)", async ({
  page,
}) => {
  // Regression for the pane-width bug. The rendered <svg> carries `max-width: 100%`,
  // so a preview pane narrower than the page's intrinsic width (point × 96/72)
  // SHRINKS the SVG to fit. The forward overlay used to be placed in fixed physical
  // px and did NOT shrink with it, so the highlight drifted off its line — worse the
  // further down the page — which is exactly what users saw when the agent pane
  // narrowed the preview. Faithful, inverse-sync-INDEPENDENT check: the highlight's
  // vertical center, as a FRACTION of the rendered SVG, must stay put as the preview
  // width changes. With the bug that fraction moves; with the fix it is invariant.
  await page.goto("/?seed=einstein");

  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await expect(
    page.locator('[data-testid="preview"] svg').first(),
  ).toBeVisible();
  const previewPage = page
    .locator('[data-testid="preview"] .preview-page')
    .first();
  await expect(previewPage).toHaveAttribute("data-source-clickable", "true", {
    timeout: 60_000,
  });

  // Park the cursor on a content-bearing line so a highlight resolves (any region
  // is fine — we only compare its position to itself across two widths).
  const content = page.locator('[data-testid="editor"] .cm-content');
  const highlight = page.locator('[data-testid="preview-source-highlight"]');
  await content.click();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowDown");
  await expect
    .poll(
      async () => {
        if (await highlight.count()) return true;
        await content.click();
        await page.keyboard.press("ArrowDown");
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(highlight).toBeVisible({ timeout: 3_000 });

  // Highlight center expressed as a fraction of the rendered SVG box (the document
  // position it marks). Folds in the `max-width` shrink and any zoom transform.
  const measure = () =>
    page.evaluate(() => {
      const svg = document.querySelector(
        '[data-testid="preview"] svg',
      ) as SVGSVGElement | null;
      const hl = document.querySelector(
        '[data-testid="preview-source-highlight"]',
      ) as HTMLElement | null;
      const sb = svg?.getBoundingClientRect();
      const hb = hl?.getBoundingClientRect();
      if (!sb || !hb || sb.height <= 0) return null;
      return { width: sb.width, frac: (hb.top + hb.height / 2 - sb.top) / sb.height };
    });

  const railAgent = page.getByTestId("rail-agent");
  // WIDE preview: collapse the agent pane and widen the window so the page renders
  // at (or near) its intrinsic width.
  if ((await railAgent.getAttribute("aria-pressed")) === "true") {
    await railAgent.click();
  }
  await page.setViewportSize({ width: 1700, height: 900 });
  await expect
    .poll(async () => (await measure())?.width ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const wide = await measure();
  expect(wide).not.toBeNull();

  // NARROW preview: re-open the agent pane and shrink the window so `max-width`
  // shrinks the SVG well below its intrinsic width.
  if ((await railAgent.getAttribute("aria-pressed")) !== "true") {
    await railAgent.click();
  }
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect
    .poll(async () => (await measure())?.width ?? 1e9, { timeout: 10_000 })
    .toBeLessThan(wide!.width - 20);
  const narrow = await measure();
  expect(narrow).not.toBeNull();

  // Precondition: the preview width genuinely changed (else the test proves nothing).
  expect(wide!.width - narrow!.width).toBeGreaterThan(20);
  // The fix: the highlight stays on the same document fraction regardless of width.
  // (With the bug, the fixed-px overlay stays put while the SVG shrinks, so the
  // fraction drifts by far more than this.)
  expect(Math.abs(wide!.frac - narrow!.frac)).toBeLessThan(0.01);
});
