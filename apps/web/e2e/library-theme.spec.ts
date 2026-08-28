import { test, expect } from "@playwright/test";

/**
 * R5 — the library / Projects route must theme to dark like the editor shells.
 *
 * Regression guard for the bug where the library route rendered byte-identical in
 * light and dark: `LibraryRoot` never set the `data-theme` attribute, so its
 * token-driven CSS (--paper-sunk / --paper-raised / --line / --ink) stayed on
 * the light values. We assert two things:
 *   1. With a stored "dark" preference, the library boot reflects `data-theme`
 *      and its surface paints a DARK background (not the light paper-sunk).
 *   2. The light boot (no stored preference) stays light — proving the dark
 *      surface in (1) is genuinely theme-driven, not a constant.
 */

/** Parse a `rgb(...)`/`rgba(...)` string to its [r,g,b] channels. */
function channels(color: string): number[] {
  return (color.match(/\d+/g) ?? []).map(Number).slice(0, 3);
}

test("library: dark preference themes the Projects surface dark (R5)", async ({ page }) => {
  // Seed the stored theme BEFORE the app boots so LibraryRoot resolves "dark".
  await page.addInitScript(() => {
    try {
      localStorage.setItem("galley.theme", "dark");
    } catch {
      /* storage unavailable */
    }
  });

  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible();

  // The boot must have reflected the dark theme onto the document root.
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.getAttribute("data-theme")),
  ).toBe("dark");

  // The library surface background must be DARK (every channel low), i.e. the
  // dark --paper-sunk (#15120e), not the light paper.
  const bg = await page
    .getByTestId("library")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const ch = channels(bg);
  expect(ch.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(ch[0], ch[1], ch[2])).toBeLessThan(80);
});

test("library: default boot stays light (no stored preference)", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("galley.theme");
    } catch {
      /* storage unavailable */
    }
    // Force light regardless of the runner's OS color-scheme.
    // (matchMedia is read-only; emulate via the param below instead.)
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible();

  // No dark attribute → light theme (absence-of-attribute default).
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.getAttribute("data-theme")),
  ).toBeNull();

  // The library surface is LIGHT (every channel high) — the light --paper-sunk.
  const bg = await page
    .getByTestId("library")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const ch = channels(bg);
  expect(Math.min(ch[0], ch[1], ch[2])).toBeGreaterThan(200);
});
