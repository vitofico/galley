import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * Mount e2e for the citation library DEDUP mode (#6) — a user-initiated merge of
 * duplicate entries ALREADY in the project bibliography. We seed a known duplicate
 * (two BibTeX entries sharing one DOI) into the demo's /refs.bib, open the Add-
 * citation panel's "Deduplicate" tab, scan, and apply. The merge SURGICALLY removes
 * the duplicate (the file stays BibTeX — so Typst's `.bib` compile and the cite-key
 * readers keep working) and lands as ONE undoable CRDT edit.
 *
 * Two tests, because the undo stack is per-editor-mount (each file's editor has its
 * own Yjs UndoManager, recreated on file switch): one test switches files to prove
 * the cite-key READER still sees the surviving key, the other stays on /refs.bib to
 * prove a single ⌘Z reverts the whole merge. Boots the default `/` route (a fresh,
 * hermetic demo workspace per test).
 */

// Two entries, same DOI → one duplicate cluster. The second carries a `volume`
// the first lacks (the duplicate's extra data the merge surfaces in the preview).
const DUP_BIB =
  "@article{first, title={Shared Work}, author={Doe, Jane}, year={2020}, " +
  "doi={10.1234/shared}}\n" +
  "@article{second, title={Shared Work}, author={Doe, Jane}, year={2020}, " +
  "doi={10.1234/shared}, volume={9}}\n";

/** Seed /refs.bib with the two duplicates, open the dedup tab, scan, and apply. */
async function seedAndDedup(page: import("@playwright/test").Page) {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Open /refs.bib (seeded by the demo workspace) and replace it with our two
  // duplicate entries.
  await page.locator('[data-testid="project-file"][data-path="/refs.bib"]').click();
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(DUP_BIB);
  await expect(editor).toContainText("10.1234/shared");

  // Open the Add-citation panel and switch to the Deduplicate tab.
  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await expect(page.getByTestId("citation-panel")).toBeVisible();
  await page.getByTestId("citation-mode-dedup").click();

  // Scan finds exactly one duplicate cluster.
  await page.getByTestId("citation-dedup-scan").click();
  await expect(page.getByTestId("citation-dedup-summary")).toContainText("removed");
  await expect(page.getByTestId("citation-dedup-list")).toContainText("Shared Work");

  // Apply the merge.
  await page.getByTestId("citation-dedup-apply").click();
  await expect(page.getByTestId("citation-dedup-summary")).toContainText(/Merged \d+ entries/);
  return editor;
}

test("#6 dedup: result is still BibTeX and the cite-key readers stay intact", async ({ page }) => {
  const editor = await seedAndDedup(page);

  // The .bib now holds ONE entry, STILL BibTeX (not converted): the surviving
  // `@article{first` is kept verbatim, the duplicate `@article{second` is gone.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor).toContainText("@article{first");
  await expect(editor).not.toContainText("@article{second");

  // READERS NOT BROKEN: the cite-key autocomplete (fed by the BibTeX bib parser)
  // still offers the surviving key. The rail dock shows ONE panel at a time, so
  // switching the dock to Files closes the Insert/citation panel — then switch to
  // main.typ and start an `@`-cite.
  await page.getByTestId("rail-files").click();
  await expect(page.getByTestId("citation-panel")).toHaveCount(0);
  await page.locator('[data-testid="project-file"][data-path="/main.typ"]').click();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("See @fir");
  await page.keyboard.press("Control+Space");
  const menu = page.locator(".cm-tooltip-autocomplete");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu).toContainText("first");
});

test("#6 dedup: a single Undo reverts the whole merge", async ({ page }) => {
  const editor = await seedAndDedup(page);

  // The duplicate is gone after apply…
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor).toContainText("@article{first");
  await expect(editor).not.toContainText("@article{second");

  // …and ONE Undo, on the same /refs.bib editor mount, brings both entries back.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toContainText("@article{second");
  await expect(editor).toContainText("@article{first");
});
