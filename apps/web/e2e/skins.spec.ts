import { test, expect } from "@playwright/test";

/**
 * Skin switching + persistence — end-to-end gate.
 *
 * The skin system (skin.ts) is orthogonal to theme.ts's light/dark mode:
 *   "studio" = tangerine accent (#f0510e — the Galley logo color), default =
 *              ABSENCE of data-skin
 *   "press"  = gold accent (#e8b04b), data-skin="press" on :root
 *
 * Assertions:
 *   1. Fresh load (cleared storage) → no data-skin attribute; --accent is the
 *      Studio tangerine rgb(240, 81, 14).
 *   2. Click Press in Settings → data-skin="press"; --accent gold
 *      rgb(232, 176, 75); choice persisted to localStorage.
 *   3. Reload → data-skin="press" still present (persistence round-trip).
 *   4. Click Studio → attribute removed; --accent back to tangerine.
 */

/** Read the computed value of a CSS custom property on :root. */
function accentHex(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    // May arrive as "#rrggbb" or "rgb(r, g, b)" depending on browser; normalise
    // to lowercase for comparison.
    return raw.toLowerCase();
  });
}

test("skins: fresh load defaults to Studio (no data-skin, tangerine accent)", async ({ page }) => {
  // Clear any stored skin before the app boots.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("galley.skin");
    } catch {
      /* storage unavailable */
    }
  });

  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // Studio is the default = ABSENCE of the attribute.
  await expect(page.locator("html")).not.toHaveAttribute("data-skin");

  // The studio-skin button reflects the default selection.
  await expect(page.getByTestId("settings-skin-studio")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-skin-press")).toHaveAttribute("aria-pressed", "false");

  // --accent resolves to Studio tangerine #f0510e = rgb(240, 81, 14).
  const accent = await accentHex(page);
  // Accept the hex literal or the rgb() form the browser may return.
  expect(["#f0510e", "rgb(240, 81, 14)"]).toContain(accent);
});

test("skins: choosing Press sets data-skin, changes --accent, and persists to storage", async ({
  page,
}) => {
  // Ensure we start from Studio (no stored skin).
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("galley.skin");
    } catch {
      /* storage unavailable */
    }
  });

  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // Click Press.
  await page.getByTestId("settings-skin-press").click();

  // data-skin="press" must appear on the document root immediately.
  await expect(page.locator("html")).toHaveAttribute("data-skin", "press");

  // aria-pressed flips.
  await expect(page.getByTestId("settings-skin-press")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-skin-studio")).toHaveAttribute("aria-pressed", "false");

  // --accent becomes Press gold #e8b04b = rgb(232, 176, 75).
  const accent = await accentHex(page);
  expect(["#e8b04b", "rgb(232, 176, 75)"]).toContain(accent);

  // Persisted to localStorage.
  const stored = await page.evaluate(() => localStorage.getItem("galley.skin"));
  expect(stored).toBe("press");
});

test("skins: Press choice persists across a page reload", async ({ page }) => {
  // Seed the stored skin BEFORE the app boots so the boot resolver picks it up.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("galley.skin", "press");
    } catch {
      /* storage unavailable */
    }
  });

  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // The boot must have reflected the stored skin onto the document root.
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.getAttribute("data-skin")),
  ).toBe("press");

  // The picker reflects the restored state.
  await expect(page.getByTestId("settings-skin-press")).toHaveAttribute("aria-pressed", "true");
});

test("skins: switching back to Studio removes data-skin and restores tangerine accent", async ({
  page,
}) => {
  // Start from a persisted Press choice.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("galley.skin", "press");
    } catch {
      /* storage unavailable */
    }
  });

  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // Confirm we're in Press.
  await expect(page.locator("html")).toHaveAttribute("data-skin", "press");

  // Click Studio.
  await page.getByTestId("settings-skin-studio").click();

  // Studio = ABSENCE of the attribute.
  await expect(page.locator("html")).not.toHaveAttribute("data-skin");

  // aria-pressed flips back.
  await expect(page.getByTestId("settings-skin-studio")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-skin-press")).toHaveAttribute("aria-pressed", "false");

  // --accent is Studio tangerine again.
  const accent = await accentHex(page);
  expect(["#f0510e", "rgb(240, 81, 14)"]).toContain(accent);

  // Storage updated.
  const stored = await page.evaluate(() => localStorage.getItem("galley.skin"));
  expect(stored).toBe("studio");
});
