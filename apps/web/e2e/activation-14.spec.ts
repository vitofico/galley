import { test, expect } from "@playwright/test";
import { gotoEditor, skipDemoSeed } from "./app-helpers.js";
import { committedUpdateCount } from "./idb-helpers";

/** The default `/` boots UnifiedRoot → a persistent project db keyed by a `proj-…` id. */
const PROJECT_DB_PREFIX = "galley-local-project-v1-";

/**
 * Activation e2e for the wave-2 cluster (the serial activation sequence):
 *   - #14 the persistent-project boot is now the DEFAULT `/` (the activation flip,
 *     criteria 1 + 3): a fresh visit opens a persistent local project that SURVIVES
 *     A RELOAD with no flag.
 *   - #12.3 the project library/dashboard (`/library`): create → open a project.
 *   - #11.5-UI editor preferences: edit + persist a preference (relocated by
 *     #19.7 from the rail-foot "Aa" dock to the /settings Editor section).
 */

test("the default route opens a persistent project that survives a reload (#14)", async ({ page }) => {
  await gotoEditor(page);

  // The bare default boots the project shell (reusing ProjectApp) — NO flag.
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Baseline: wait until the seed has durably committed to IndexedDB (db exists,
  // count > 0), so the post-typing assertion below compares against a real floor.
  await expect.poll(() => committedUpdateCount(page, PROJECT_DB_PREFIX), { timeout: 30_000 }).toBeGreaterThan(0);
  const baseline = await committedUpdateCount(page, PROJECT_DB_PREFIX);

  // Type a distinctive marker into the active file.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Persisted Heading XYZ");
  await expect(editor).toContainText("Persisted Heading XYZ");

  // Durable-write barrier (L6-T2): instead of a fixed sleep, poll until the typed
  // CRDT updates have COMMITTED to IndexedDB (committed count exceeds the seed
  // baseline). By IndexedDB transaction ordering this only passes once every
  // keystroke's write has landed, so the reload below restores the full text — no
  // wall-clock guess, no aborted-mid-flush prefix. (no ?id= → the persisted
  // default project id is reused, so the same doc is restored.)
  await expect.poll(() => committedUpdateCount(page, PROJECT_DB_PREFIX), { timeout: 30_000 }).toBeGreaterThan(baseline);
  await page.reload();

  await expect(page.getByTestId("open-library")).toBeVisible();
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Persisted Heading XYZ",
    { timeout: 30_000 },
  );
});

test("library dashboard creates and opens a project (#12.3)", async ({ page }) => {
  // Opt out of the one-time Einstein demo seed so this asserts a truly empty
  // library (the demo card would otherwise occupy the fresh context).
  await skipDemoSeed(page);
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible();
  // Fresh browser context (demo seed skipped) → no projects yet.
  await expect(page.getByTestId("library-empty")).toBeVisible();

  // Create one — expand the "+" tile, name it; a card appears.
  await page.getByTestId("new-project-tile").click();
  await page.getByTestId("new-project-name").fill("My Thesis");
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await expect(page.getByTestId("project-card")).toContainText("My Thesis");

  // Opening it launches the unified project shell.
  await page.getByTestId("open-project").click();
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
});

test("editor preferences edit and persist a setting (#11.5-UI, on /settings since #19.7)", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The editor shell no longer hosts the prefs panel (the Aa dock is retired);
  // ⌘, opens its new home, the /settings Editor section (settings is off the
  // editor chrome — no rail gear).
  await expect(page.getByTestId("editor-prefs")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(page.getByTestId("editor-prefs")).toBeVisible();

  // Change the font size; it persists to localStorage (applied on editor remount).
  await page.getByTestId("editor-prefs-font-size").fill("20");
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("galley.editor.prefs.v1") ?? ""))
    .toContain("20");

  // Back to the editor — the relocated panel never lingers in the shell.
  await page.getByTestId("settings-back").click();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("editor-prefs")).toHaveCount(0);
});
