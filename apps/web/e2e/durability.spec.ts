import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #23.1 — data-durability guard (e2e).
 *
 * Galley's local-first data lives in EVICTABLE IndexedDB. The guard requests
 * persistent storage on boot and, when durability can't be guaranteed (the
 * browser refuses to persist, or storage is nearly full), surfaces a calm,
 * dismissible nudge whose "Back up a copy" CTA reuses the existing Export PDF
 * path. The hard part in a real browser is FORCING the at-risk state — we can't
 * make Chromium deny persistence on demand — so we override the StorageManager
 * methods via `addInitScript` BEFORE any app code runs (the same ordering trick
 * runtime-config.spec.ts uses for the injected config global).
 */

/** Stand in a fake StorageManager shape before the bundle loads. */
async function fakeStorage(
  page: import("@playwright/test").Page,
  shape: { persist: boolean; persisted: boolean; usage: number; quota: number },
) {
  await page.addInitScript((s) => {
    // Some headless contexts have no navigator.storage at all; define a shim, then
    // override the methods deterministically. Configurable so the override sticks.
    const nav = navigator as unknown as { storage?: Record<string, unknown> };
    if (!nav.storage) nav.storage = {};
    Object.defineProperty(nav.storage, "persist", {
      configurable: true,
      value: async () => s.persist,
    });
    Object.defineProperty(nav.storage, "persisted", {
      configurable: true,
      value: async () => s.persisted,
    });
    Object.defineProperty(nav.storage, "estimate", {
      configurable: true,
      value: async () => ({ usage: s.usage, quota: s.quota }),
    });
  }, shape);
}

test("at-risk (transient + pressure): the durability nudge appears, backs up via Export, and dismisses", async ({
  page,
}) => {
  // Browser refuses to persist AND storage is near the cap → transient under real
  // pressure → at-risk (denied persistence alone is not enough; see the low-usage
  // case below).
  await fakeStorage(page, { persist: false, persisted: false, usage: 950, quota: 1_000 });

  // Capture the export download so the CTA is proven to fire the existing path.
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const notice = page.getByTestId("durability-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText(/evict/i);

  // The CTA reuses Export PDF — clicking it triggers a real browser download.
  const backup = page.getByTestId("durability-backup");
  await expect(backup).toBeVisible();
  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    backup.click(),
  ]);
  expect(download[0].suggestedFilename()).toMatch(/\.pdf$/i);

  // Dismiss hides it for the session.
  await page.getByTestId("durability-dismiss").click();
  await expect(notice).toHaveCount(0);
});

test("at-risk (storage nearly full): persisted but over the pressure threshold still nudges", async ({
  page,
}) => {
  // Persisted, but 95% of quota used → over the 0.9 high-water mark → at-risk.
  await fakeStorage(page, { persist: true, persisted: true, usage: 950, quota: 1_000 });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const notice = page.getByTestId("durability-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText(/full|nearly/i);
});

test("healthy (persisted + low usage): NO durability nudge renders", async ({ page }) => {
  // Persisted and well under quota → ok → the additive guard renders nothing.
  await fakeStorage(page, { persist: true, persisted: true, usage: 10, quota: 1_000 });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Give the mount effect ample time to resolve, then assert absence.
  await expect(page.getByTestId("save-state")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("durability-notice")).toHaveCount(0);
});

test("ok (transient + low usage): persistence denied but usage low → NO durability nudge", async ({
  page,
}) => {
  // Private/incognito mode commonly denies persistence; on a fresh project with
  // negligible usage that is NOT an at-risk situation — the loud AT-RISK eviction
  // nudge (`durability-notice`) would be a false alarm, so it must stay silent
  // here. (Transient origins DO now get the calmer M9 info banner + the
  // save-popover cue — see the M9 tests below; this test only pins that the
  // pressure-gated AT-RISK nudge does not fire.)
  await fakeStorage(page, { persist: false, persisted: false, usage: 10, quota: 1_000 });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Give the mount effect ample time to resolve, then assert absence of the
  // AT-RISK nudge specifically (the M9 transient info banner is a separate cue).
  await expect(page.getByTestId("save-state")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("durability-notice")).toHaveCount(0);
});

test("transient: the save-popover backup cue strengthens to warn about private/incognito loss", async ({
  page,
}) => {
  // Transient + low usage: no AT-RISK eviction nudge, but the passive Save-row cue
  // gives a SPECIFIC warning (and, since M9, a top-level info banner too — covered
  // separately below). This test pins the popover cue strengthening.
  await fakeStorage(page, { persist: false, persisted: false, usage: 10, quota: 1_000 });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("status-chip").click();
  const cue = page.getByTestId("status-popover").getByTestId("status-backup-cue");
  await expect(cue).toBeVisible();
  await expect(cue).toHaveAttribute("data-transient", "true");
  await expect(cue).toContainText(/private|incognito|close/i);
});

test("persisted: the save-popover backup cue stays the calm generic local-only reminder", async ({
  page,
}) => {
  // Persisted origin: the cue is the gentle resting reminder, NOT the transient
  // warning — so we don't over-warn a durable browser.
  await fakeStorage(page, { persist: true, persisted: true, usage: 10, quota: 1_000 });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("status-chip").click();
  const cue = page.getByTestId("status-popover").getByTestId("status-backup-cue");
  await expect(cue).toBeVisible();
  await expect(cue).not.toHaveAttribute("data-transient", "true");
  await expect(cue).toContainText(/lives only here/i);
});

/**
 * M9 (operator-approved) — a fresh transient/incognito origin gets a calm,
 * one-time dismissible TOP-LEVEL info banner up front, instead of the warning
 * being buried in the opt-in save-status popover. Distinct from the pressure-
 * gated at-risk nudge: it fires on transient even at LOW usage.
 */
test("M9: a fresh transient origin gets a one-time dismissible top-level storage banner", async ({
  page,
}) => {
  await fakeStorage(page, { persist: false, persisted: false, usage: 10, quota: 1_000 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Low usage → the at-risk eviction nudge stays silent; the M9 info banner shows.
  await expect(page.getByTestId("durability-notice")).toHaveCount(0);
  const banner = page.getByTestId("transient-storage-banner");
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText(/private|incognito|close/i);

  // Dismiss → gone, and stays gone across a reload (localStorage-persisted).
  await page.getByTestId("transient-storage-dismiss").click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("transient-storage-banner")).toHaveCount(0);
});

test("M9: a persisted origin shows NO transient storage banner (old path unchanged)", async ({
  page,
}) => {
  await fakeStorage(page, { persist: true, persisted: true, usage: 10, quota: 1_000 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("transient-storage-banner")).toHaveCount(0);
});
