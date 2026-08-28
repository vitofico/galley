import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

/**
 * #17.5 raster off-ramp — "Export PNG". The rendered document can be downloaded
 * as an image: a single `.png` for a one-page doc, or a `.tar` of `page-N.png`
 * for a multi-page doc. This covers the browser-only canvas rasterize step that
 * the node unit gate can't (jsdom has no real canvas → no PNG bytes); the pure
 * splitting/packing logic is unit-tested in export-raster.test.ts.
 */

/** PNG 8-byte file signature. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

test("Export PNG of a single-page doc downloads a real PNG", async ({ page }) => {
  // Surface any in-page failure (the rasterize path uses Image/canvas at runtime)
  // as a test-visible error instead of a silent download timeout.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // Force a deterministic ONE-page document so the export takes the single-.png
  // branch. Replace the active editor's content with a tiny single-page doc.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Hello\n\nA one page document.");
  // Wait for a recompile that reports exactly one page.
  await expect(page.getByTestId("status")).toHaveText(/1 page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("export-menu-button").click();
  await expect(page.getByTestId("export-png")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-png").click(),
  ]);
  expect(download.suggestedFilename()).toBe("document.png");

  // The downloaded bytes are a real PNG (valid 8-byte signature).
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = new Uint8Array(await readFile(path!));
  expect(bytes.length).toBeGreaterThan(8);
  expect(startsWithPng(bytes)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("Export PNG of a multi-page doc downloads a .tar of page-N.png", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  await page.goto("/?seed=einstein");
  // The default workspace (Einstein 1905) renders multiple pages.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // Build a deterministic multi-page doc (a forced page break).
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= One\n\nFirst page.\n\n#pagebreak()\n\n= Two\n\nSecond page.");
  await expect(page.getByTestId("status")).toHaveText(/2 page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("export-menu-button").click();
  await expect(page.getByTestId("export-png")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-png").click(),
  ]);
  expect(download.suggestedFilename()).toBe("document-pages.tar");

  // The tar embeds both honest page filenames and at least one PNG signature.
  const path = await download.path();
  const bytes = new Uint8Array(await readFile(path!));
  const text = new TextDecoder("latin1").decode(bytes);
  expect(text).toContain("page-1.png");
  expect(text).toContain("page-2.png");
  // A PNG magic appears somewhere in the archive body (a packed page image).
  let hasPng = false;
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (startsWithPng(bytes.subarray(i, i + 8))) {
      hasPng = true;
      break;
    }
  }
  expect(hasPng).toBe(true);
  expect(pageErrors).toEqual([]);
});
