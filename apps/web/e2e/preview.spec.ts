import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * M0 acceptance e2e: the editor → live preview loop works in a real browser with
 * the real WASM compiler, and a syntax error surfaces a located diagnostic.
 */
test("renders the sample document and locates a syntax error", async ({ page }) => {
  await gotoEditor(page);

  // The compiler loads its WASM behind a loading state; wait for it to be ready
  // (status flips from "Loading compiler…" to a page count).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The sample document renders to an SVG in the preview.
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // Replace the document with one that has a syntax error (`#let` with no value).
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n#let x =");

  // The status reflects the error, and a located diagnostic appears.
  await expect(page.getByTestId("status")).toContainText(/error/i, { timeout: 30_000 });
  await expect(page.getByTestId("diagnostics")).toContainText(/error/i);
});

test("preview 'fit' follows a pane resize (B16)", async ({ page }) => {
  // Default route boots the multi-pane ProjectApp (editor | preview | sidebar with
  // draggable splitters). B16: a fitted zoom is recomputed when the splitter
  // resizes the preview pane — previously Fit was a one-shot click with no
  // ResizeObserver, so narrowing the pane left the zoom stale.
  // Use a WIDE viewport so the preview pane is comfortably bigger than ~half the
  // A4 document's intrinsic width. Fit-width scales the page to the pane, clamped
  // to [50%, 300%]. At the default 1280px viewport (with the Files dock open) the
  // preview pane is only ~270px while the A4 page is ~795px CSS px, so the fit
  // pins to the 50% MIN clamp and a resize can never move the readout — nothing to
  // observe. A wide viewport puts the fitted zoom well inside the unclamped band
  // (~90%), leaving headroom for a narrowing drag to drop it meaningfully (to
  // ~65%) while staying above the 50% floor — a genuine re-fit, not a clamp.
  await page.setViewportSize({ width: 2560, height: 1440 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  const preview = page.getByTestId("preview");
  const zoomLevel = page.getByTestId("preview-zoom-level");

  // Read the current "NNN%" as a number (the readout stays in the DOM even when
  // the floating pill is idle/faded).
  const readZoom = async () => {
    const txt = (await zoomLevel.textContent())?.trim() ?? "";
    return Number.parseInt(txt.replace("%", ""), 10);
  };

  // Wake the floating zoom pill and PARK the pointer on it before clicking.
  //
  // The pill fades after ZOOM_PILL_IDLE_MS (1.5s) to `data-idle="true"`, which is
  // `opacity:0; pointer-events:none`. A single wake-then-click races that timer:
  // Playwright hit-tests for actionability BEFORE it moves the mouse, so once the
  // pill sleeps the click waits for an element that only a pointermove could wake —
  // and no move is coming. Chromium won the race; WebKit is slower and deadlocked
  // for the full 90s timeout (CX-3).
  //
  // Parking the pointer ON the pill removes the race entirely rather than widening
  // it: `sleep()` suspends the fade while the pill matches `:hover`, so it stays
  // awake for as long as the click takes, at any browser speed.
  //   move 1 — while asleep the pill is not hit-testable, so this lands on the
  //            scroll host BENEATH it (the pill is a sibling of the host, not a
  //            child), firing the host `pointermove` that clears `data-idle`.
  //   move 2 — now that the pill is hit-testable, this re-runs hit-testing so
  //            `:hover` actually matches; that is what suspends the fade.
  const fitButton = page.getByRole("button", { name: "Fit width" });
  const fitBox = await fitButton.boundingBox();
  const fitX = fitBox!.x + fitBox!.width / 2;
  const fitY = fitBox!.y + fitBox!.height / 2;
  await page.mouse.move(fitX, fitY);
  await page.mouse.move(fitX, fitY + 1);
  await fitButton.click();

  // The fitted zoom is now keyed to the CURRENT preview width.
  let fitted = 0;
  await expect
    .poll(async () => (fitted = await readZoom()), { timeout: 10_000 })
    .toBeGreaterThan(0);

  // Drag the editor|preview splitter to the RIGHT, widening the editor and so
  // NARROWING the preview pane. SplitPanes only mutates `--col-*` CSS variables —
  // there is no window/pane resize event — so only the ResizeObserver B16 adds can
  // notice the width change and re-fit.
  const splitter = page.locator('[data-testid="splitter"][data-left="editor"]');
  await expect(splitter).toBeVisible();
  const sb = await splitter.boundingBox();
  await page.mouse.move(sb!.x + sb!.width / 2, sb!.y + sb!.height / 2);
  await page.mouse.down();
  // Move well to the right in steps so the live drag handler tracks it.
  await page.mouse.move(sb!.x + 220, sb!.y + sb!.height / 2, { steps: 12 });
  await page.mouse.up();

  // A narrower preview must yield a SMALLER fitted zoom — proving the fit
  // recomputed automatically in response to the pane resize.
  await expect
    .poll(readZoom, { timeout: 10_000 })
    .toBeLessThan(fitted);
});
