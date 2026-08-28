import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * Multi-file project shell (roadmap #2, slice 6), real browser + real WASM:
 * the default `/` boot seeds the "Annus Mirabilis" demo workspace (#20.2: seven
 * files), compiles the WHOLE project (the `#include` chain resolves), switches the
 * active file, and an edit to one file recompiles the project and surfaces a
 * per-file diagnostic.
 */
test("project mode: multi-file project compiles, switches files, and recompiles on edit", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");

  // It's the project shell (not the single-file App).
  await expect(page.getByTestId("open-library")).toBeVisible();

  // The whole project compiles clean (the #include chain + cross-file refs resolve).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // The file list shows the eight seeded demo files.
  await expect(page.getByTestId("project-file")).toHaveCount(8);
  await expect(page.locator('[data-testid="project-file"][data-path="/main.typ"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/relativity.typ"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="project-file"][data-path="/refs.bib"]')).toBeVisible();

  // Active file defaults to main; the editor shows its content.
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Annus Mirabilis",
  );

  // Switch to relativity.typ — the editor now shows that file's distinctive content.
  await page.locator('[data-testid="project-file"][data-path="/relativity.typ"]').click();
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Electrodynamics of Moving Bodies",
  );

  // Break the active file — the project recompiles and an error surfaces.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("#broken (");
  // (bisect) did the keystrokes land in the editor's Y.Text?
  await expect(editor).toContainText("#broken (");
  // did the edit flow to a recompile that errors?
  await expect(page.getByTestId("status")).toContainText(/error/i, { timeout: 30_000 });
  await expect(page.getByTestId("diagnostics")).toContainText(/error/i);
});

test("project mode: file ops — create, duplicate-block, rename, delete, set-main", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file")).toHaveCount(8);

  // Create a file via the new-file form.
  await page.getByTestId("new-file-path").fill("/notes.typ");
  await page.getByTestId("add-file").click();
  await expect(page.getByTestId("project-file")).toHaveCount(9);
  await expect(page.locator('[data-testid="project-file"][data-path="/notes.typ"]')).toBeVisible();

  // A duplicate path blocks compile (the core surfaces it; we never silently merge).
  await page.getByTestId("new-file-path").fill("/notes.typ");
  await page.getByTestId("add-file").click();
  await expect(page.getByTestId("project-file")).toHaveCount(10);
  await expect(page.getByTestId("status")).toContainText(/duplicate/i, { timeout: 30_000 });

  // Resolve by deleting the active duplicate; compile recovers.
  await page.locator('.project-file-row:has(.is-active) [data-testid="delete-file"]').click();
  await expect(page.getByTestId("project-file")).toHaveCount(9);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });

  // Rename /notes.typ -> /renamed.typ.
  await page.locator('[data-testid="rename-file"][data-path="/notes.typ"]').click();
  await page.getByTestId("rename-input").fill("/renamed.typ");
  await page.getByTestId("rename-input").press("Enter");
  await expect(page.locator('[data-testid="project-file"][data-path="/renamed.typ"]')).toBeVisible();
  await expect(page.locator('[data-testid="project-file"][data-path="/notes.typ"]')).toHaveCount(0);

  // Delete /renamed.typ.
  await page.locator('[data-testid="delete-file"][data-path="/renamed.typ"]').click();
  await expect(page.getByTestId("project-file")).toHaveCount(8);

  // Set-main: /main.typ is main (no set-main button); switch main to /marginalia.typ
  // (self-contained — it compiles standalone).
  await expect(
    page.locator('[data-testid="set-main"][data-path="/main.typ"]'),
  ).toHaveCount(0);
  await page.locator('[data-testid="set-main"][data-path="/marginalia.typ"]').click();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/marginalia.typ"] .project-file-main'),
  ).toBeVisible();
});

test("project mode: deleting the main file surfaces a recovery notice (L1-C2)", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file")).toHaveCount(8);
  await expect(page.getByTestId("main-deleted-notice")).toHaveCount(0);

  // Add a file with real content and make it the project's main.
  await page.getByTestId("new-file-path").fill("/cover.typ");
  await page.getByTestId("add-file").click();
  const cover = page.locator('[data-testid="editor"] .cm-content');
  await cover.click();
  await page.keyboard.type("= Cover\n\nHello from the cover.");
  await page.locator('[data-testid="set-main"][data-path="/cover.typ"]').click();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });

  // Delete the MAIN file. The core does NOT auto-reassign main (ADR-0013), so the
  // compile input goes null and the preview stops — the UI must guide recovery
  // rather than leaving a silently-dead preview (L1-C2).
  await page.locator('[data-testid="delete-file"][data-path="/cover.typ"]').click();
  await expect(page.getByTestId("main-deleted-notice")).toBeVisible();
  await expect(page.getByTestId("status")).toContainText(/no main file/i, { timeout: 30_000 });

  // Pick a new main via the affordance the notice points to; the preview recovers
  // (/main.typ paginates) and the notice clears.
  await page.locator('[data-testid="set-main"][data-path="/main.typ"]').click();
  await expect(page.getByTestId("main-deleted-notice")).toHaveCount(0);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });
});

test("project mode: the active-file agent runs with whole-project context and Accept applies", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  // The agent targets the active file (main by default).
  await expect(page.getByTestId("agent-target")).toContainText("/main.typ");

  // Run the demo agent (request prefilled). It self-corrects a broken edit to a
  // clean compile — checked against the WHOLE project (the #import resolves).
  await page.getByTestId("agent-send").click();
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  await expect(diff).toContainText(/Demo Section/);
  await expect(page.getByTestId("agent-trace")).toContainText(/error/i); // self-corrected

  // Accept applies the edit to the active file and the project recompiles clean.
  await page.getByTestId("accept").click();
  await expect(diff).toHaveCount(0);
  // The demo agent appends at the END of the (viewport-tall) demo main.typ;
  // CodeMirror renders only visible lines, so scroll to the end first.
  const content = page.locator('[data-testid="editor"] .cm-content');
  await content.click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(content).toContainText("Inserted by the Galley demo agent.");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });
});
