import { test, expect } from "@playwright/test";

/**
 * M5 — a failed clipboard copy is no longer silent. When `navigator.clipboard`
 * rejects (denied permission) or is unavailable (insecure context), clicking
 * "Copy" on the share link focuses + selects the link input so the user can
 * copy it manually (⌘C) instead of getting no feedback at all.
 */
test("copy-link failure focuses the share link for a manual copy (M5)", async ({ page }) => {
  // Force every clipboard write to reject, before any app script runs.
  await page.addInitScript(() => {
    const deny = () => Promise.reject(new Error("clipboard denied"));
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        get: () => ({ writeText: deny }),
      });
    } catch {
      if (navigator.clipboard) navigator.clipboard.writeText = deny;
    }
  });

  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Share, then wait for the link to be ready (past H8's "Connecting…" gate).
  await page.getByTestId("share-button").click();
  const linkInput = page.getByTestId("share-link");
  await expect(linkInput).toBeVisible({ timeout: 30_000 });

  // The copy fails silently in the clipboard, but the fallback focuses the link
  // input (which selects its contents) so it can be copied by hand.
  await expect(linkInput).not.toBeFocused();
  await page.getByTestId("copy-share-link").click();
  await expect(linkInput).toBeFocused();
  // The button stays "Copy" (never claims "Copied" on a failed write).
  await expect(page.getByTestId("copy-share-link")).toHaveText("Copy");
});

/**
 * M5 happy path unchanged — when the clipboard accepts the write, the button
 * confirms "Copied" and the fallback does NOT steal focus to the link input.
 */
test("copy success shows Copied and does not force-focus the link (M5)", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get: () => ({ writeText: () => Promise.resolve() }),
    });
  });

  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("share-button").click();
  const linkInput = page.getByTestId("share-link");
  await expect(linkInput).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("copy-share-link").click();
  await expect(page.getByTestId("copy-share-link")).toHaveText("Copied");
  await expect(linkInput).not.toBeFocused();
});

