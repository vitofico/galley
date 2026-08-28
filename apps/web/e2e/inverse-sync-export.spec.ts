import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * Wave-3 coordinator-sweep activation e2e. Both features are reachable on the
 * DEFAULT route (bare `/` boots ProjectApp):
 *   - #17.5 export bundle: an "Export bundle" button downloads the project as a
 *     `.typ` tar (sibling of Export PDF).
 *   - #11.3 inverse preview sync: when the forward source map is present, clicking
 *     the preview moves the editor cursor (`onSourceClick` gated on `sourceMap`).
 */

test("export bundle downloads the project as a .tar (#17.5)", async ({ page }) => {
  await page.goto("/?seed=einstein");

  // Project shell up + a render exists (so a real snapshot is bundled).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // #19.3: the export trio lives in the ONE Export menu; open it first.
  await page.getByTestId("export-menu-button").click();
  await expect(page.getByTestId("export-bundle")).toBeVisible();

  // Clicking fires a browser download; assert the suggested filename ends in .tar.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-bundle").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.tar$/);
});

test("export git repo downloads the project as a clone-ready bare-repo tar (#17.5)", async ({
  page,
}) => {
  // The export core is browser-only at runtime (Web Crypto + pako) — surface
  // any in-page failure as a test-visible error instead of a silent timeout.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  await page.goto("/?seed=einstein");

  // Project shell up + a render exists (so a real snapshot is exported).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // #19.3: the export trio lives in the ONE Export menu; open it first.
  await page.getByTestId("export-menu-button").click();
  await expect(page.getByTestId("export-git-repo")).toBeVisible();

  // Clicking fires a browser download of the bare-repo tar (project.git/ root).
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-git-repo").click(),
  ]);
  expect(download.suggestedFilename()).toBe("project.git.tar");
  expect(pageErrors).toEqual([]);
});

test("clicking the preview moves the editor cursor — inverse sync (#11.3)", async ({ page }) => {
  await page.goto("/?seed=einstein");

  // Wait for the real WASM render of the seed sample.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // Open the first `#include`d paper so the click target and the cursor live in the
  // SAME file: inverse sync (#11.3) moves the cursor WITHIN the open file. (The cover
  // is no longer a usable target — it's drawn by the imported `/style.typ`, which
  // contributes no leaves to the `#include`-ordered source map, so a cover glyph
  // maps to nothing.)
  await openFilesDock(page);
  await page.locator('[data-testid="project-file"][data-path="/photoelectric.typ"]').click();
  await expect(page.getByTestId("agent-target")).toContainText("/photoelectric.typ");

  // Inverse sync only activates when the forward source map is present, so the page
  // carries data-source-clickable="true".
  const page0 = page.locator('[data-testid="preview"] .preview-page').first();
  await expect(page0).toHaveAttribute("data-source-clickable", "true", { timeout: 60_000 });

  // Park the editor cursor at the file END. `jumpToOffset` (the inverse-sync handler)
  // re-focuses the editor itself, so the active line reliably tracks the selection
  // head regardless of the intervening preview click/blur. Starting at the end means
  // a click on the paper's FIRST sentence jumps the cursor UP — a clear, direction-
  // independent change of the active line.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");

  // The DOM index of the active line is a focus-robust proxy for the selection head
  // (CM marks the selected line .cm-activeLine; jumpToOffset re-focuses, so it stays
  // marked after the click). Read it as the active line's position among siblings.
  const activeLineIndex = () =>
    page.evaluate(() => {
      const content = document.querySelector('[data-testid="editor"] .cm-content');
      if (!content) return -1;
      const lines = Array.from(content.querySelectorAll(".cm-line"));
      const active = content.querySelector(".cm-line.cm-activeLine");
      return active ? lines.indexOf(active) : -1;
    });
  const before = await activeLineIndex();

  // Click the paper's FIRST body sentence by its TEXT — deterministic (typst.ts wraps
  // every run in a `foreignObject` div the sanitizer keeps), no page-index/scroll
  // race. A coordinate click on the run's center is what inverse sync hit-tests on,
  // and avoids `foreignObject` pointer-events quirks.
  const firstSentence = page
    .locator('[data-testid="preview"] .preview-page foreignObject')
    .filter({ hasText: "A profound formal difference" })
    .first();
  await firstSentence.scrollIntoViewIfNeeded({ timeout: 30_000 });
  const box = await firstSentence.boundingBox();
  if (!box) throw new Error("photoelectric body run has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The inverse-sync click must MOVE the editor selection to a different line (the
  // cursor jumped UP from the parked end toward the clicked first sentence).
  await expect.poll(activeLineIndex, { timeout: 15_000 }).not.toBe(before);
});

test("reverse navigation switches to the right file across a multi-file project (B14)", async ({
  page,
}) => {
  // The seed (Einstein workspace) is multi-file: `/main.typ` `#include`s the part
  // files, so the rendered preview interleaves content from several source files.
  // B14: a click on the preview now resolves to the ORIGINATING file (the source
  // map stamps each entry's filePath) and the handler switches the active file
  // before jumping — previously it only worked within the already-open file.
  await page.goto("/?seed=einstein");

  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // Inverse sync only activates when the multi-file forward source map is present.
  const page0 = page.locator('[data-testid="preview"] .preview-page').first();
  await expect(page0).toHaveAttribute("data-source-clickable", "true", { timeout: 60_000 });

  // Regression arm of B14: the active file starts as `/main.typ` (the seed's entry),
  // and we click content that ORIGINATES IN A DIFFERENT file — the first `#include`d
  // paper, `/photoelectric.typ`. Post-fix the click must switch the active file to
  // the clicked content's originating file. (We can't use the cover as the target:
  // it's drawn by the imported `/style.typ`, which contributes no leaves to the
  // `#include`-ordered source map. We also can't pin a page index: the preview
  // virtualizes/forward-scrolls, so the rendered-page order doesn't track document
  // pages. Instead we click a distinctive BODY sentence by its TEXT — typst.ts wraps
  // every run in a `foreignObject` div the sanitizer keeps, so a content-locator is
  // deterministic, and the click coords still hit-test to that run's source. We pick
  // body prose, NOT a heading: the table of contents repeats every heading's text,
  // so a heading string would also match the (main-sourced) TOC entry.
  await expect(page.getByTestId("agent-target")).toContainText("/main.typ");

  const photoelectricBody = page
    .locator('[data-testid="preview"] .preview-page foreignObject')
    .filter({ hasText: "A profound formal difference" })
    .first();
  await photoelectricBody.scrollIntoViewIfNeeded({ timeout: 30_000 });
  // Click the run's center by coordinate (the foreignObject overlay may be
  // pointer-events:none, so a coordinate click — what inverse-sync hit-tests on —
  // is more robust than element actionability).
  const box = await photoelectricBody.boundingBox();
  if (!box) throw new Error("photoelectric body run has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The clicked sentence originates in `/photoelectric.typ`, so the reverse-nav click
  // must switch the active file from `/main.typ` to `/photoelectric.typ` (the
  // cross-file file-switch behavior B14 adds). agent-target mirrors the active file.
  await expect(page.getByTestId("agent-target")).toContainText("/photoelectric.typ", {
    timeout: 15_000,
  });
});
