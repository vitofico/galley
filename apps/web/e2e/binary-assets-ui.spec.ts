import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * #7 slice 7D — the user-facing binary-asset UI: upload (picker / drop / paste),
 * insert-at-cursor (⌘K + paste), preview, download, rename and delete. These
 * drive the whole HUMAN path parallel to the zip-import one (binary-import.spec),
 * proving the bytes-before-pointer store → `createBinary` → tree → compile chain
 * plus the new affordances. Chromium-only synthetic DataTransfer / ClipboardEvent
 * is fine (the gate pins chromium).
 */

// A real 1×1 PNG (typst decodes it) — the same bytes binary-import.spec uses.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function bootEditor(page: Page, id: string): Promise<void> {
  await gotoEditor(page, { id });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
}

/** Build an in-page DataTransfer carrying one PNG File (for drop simulation). */
function makePngDataTransfer(page: Page, filename: string) {
  return page.evaluateHandle(
    ({ b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      return dt;
    },
    { b64: PNG_B64, name: filename },
  );
}

const binaryRow = (page: Page, path: string) =>
  page.locator(`[data-testid="project-binary-file"][data-path="${path}"]`);

async function pickFile(page: Page, name: string): Promise<void> {
  await page.getByTestId("upload-binary-input").setInputFiles({
    name,
    mimeType: "image/png",
    buffer: PNG,
  });
}

test("picker upload adds a binary row; ⌘K inserts a figure that really compiles", async ({
  page,
}) => {
  await bootEditor(page, "bin-picker");

  // Upload via the hidden picker (files mode) → a binary row appears.
  await pickFile(page, "logo.png");
  await expect(binaryRow(page, "/logo.png")).toBeVisible({ timeout: 30_000 });

  // ⌘K "Insert image…" opens the picker in INSERT mode: the pick uploads AND
  // inserts a `#figure(image("…"))` at the cursor. Intercept the file chooser,
  // pinned to the actual command (not .first()).
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Insert image");
  const insertItem = page.getByTestId("command-palette-item").filter({ hasText: "Insert image" });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    insertItem.first().click(),
  ]);
  await chooser.setFiles({ name: "chart.png", mimeType: "image/png", buffer: PNG });

  // The inserted image's row appears and the snippet lands in the editor.
  await expect(binaryRow(page, "/chart.png")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    'image("/chart.png")',
    { timeout: 30_000 },
  );
  // REAL compile evidence (not the stale "page(s)" text): the NEW compile must
  // embed a raster <image> in the preview SVG, and status must not go to error.
  await expect(page.locator('[data-testid="preview"] image').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("status")).not.toContainText("error");
});

test("dropping an image on the files pane uploads it", async ({ page }) => {
  await bootEditor(page, "bin-drop");
  const dataTransfer = await makePngDataTransfer(page, "dropped.png");
  await page.getByTestId("project-files").dispatchEvent("dragover", { dataTransfer });
  await page.getByTestId("project-files").dispatchEvent("drop", { dataTransfer });
  await expect(binaryRow(page, "/dropped.png")).toBeVisible({ timeout: 30_000 });
});

test("dropping an image on a folder row uploads into that folder", async ({ page }) => {
  await bootEditor(page, "bin-folderdrop");
  // Create a folder (materializes a starter file, then drops into rename mode).
  await page.getByTestId("new-folder-path").fill("figures");
  await page.getByTestId("add-folder").click();
  await page.keyboard.press("Escape"); // leave the starter-file rename
  const folderRow = page.locator('[data-testid="project-folder"][data-path="/figures"]');
  await expect(folderRow).toBeVisible({ timeout: 15_000 });

  const dataTransfer = await makePngDataTransfer(page, "plot.png");
  await folderRow.dispatchEvent("dragover", { dataTransfer });
  await folderRow.dispatchEvent("drop", { dataTransfer });

  await expect(binaryRow(page, "/figures/plot.png")).toBeVisible({ timeout: 30_000 });
  await expect(binaryRow(page, "/plot.png")).toHaveCount(0); // NOT at root
});

test("pasting an image in the editor uploads it and inserts an inline #image", async ({ page }) => {
  await bootEditor(page, "bin-paste");

  await page.locator('[data-testid="editor"] .cm-content').evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "clip.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, PNG_B64);

  await expect(binaryRow(page, "/pasted-image.png")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    'image("/pasted-image.png")',
    { timeout: 30_000 },
  );
});

test("a plain-text paste falls through to the editor (no image upload)", async ({ page }) => {
  await bootEditor(page, "bin-textpaste");
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await editor.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "HELLO_PASTED_TEXT");
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(editor).toContainText("HELLO_PASTED_TEXT", { timeout: 10_000 });
  await expect(page.locator('[data-testid="project-binary-file"]')).toHaveCount(0);
});

test("two images picked in one gesture both upload and the compile stays healthy", async ({
  page,
}) => {
  await bootEditor(page, "bin-multi");
  await page.getByTestId("upload-binary-input").setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: PNG },
    { name: "b.png", mimeType: "image/png", buffer: PNG },
  ]);
  await expect(binaryRow(page, "/a.png")).toBeVisible({ timeout: 30_000 });
  await expect(binaryRow(page, "/b.png")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("status")).toContainText(/page/);
  await expect(page.getByTestId("status")).not.toContainText("error");
});

test("uploading the same filename twice auto-suffixes the second row", async ({ page }) => {
  await bootEditor(page, "bin-suffix");
  await pickFile(page, "logo.png");
  await expect(binaryRow(page, "/logo.png")).toBeVisible({ timeout: 30_000 });
  await pickFile(page, "logo.png");
  await expect(binaryRow(page, "/logo-1.png")).toBeVisible({ timeout: 30_000 });
  await expect(binaryRow(page, "/logo.png")).toBeVisible();
  await expect(page.getByTestId("status")).toContainText(/page/);
});

test("an invalid upload surfaces a 'Skipped' notice and adds no row", async ({ page }) => {
  await bootEditor(page, "bin-reject");
  // `.galley` canonicalizes to the reserved `/.galley` namespace → rejected by
  // the path-safety gate (a tiny fixture, no 32 MiB file needed).
  await pickFile(page, ".galley");
  await expect(page.getByTestId("accept-notice")).toContainText(/Skipped/, { timeout: 10_000 });
  await expect(page.locator('[data-testid="project-binary-file"]')).toHaveCount(0);
});

test("a binary row can be renamed via its ops", async ({ page }) => {
  await bootEditor(page, "bin-rename");
  await pickFile(page, "logo.png");
  await expect(binaryRow(page, "/logo.png")).toBeVisible({ timeout: 30_000 });

  // Rows detach on recompile re-render, so retry the interaction; short inner
  // timeouts so a swallowed click actually yields to the next toPass attempt.
  await expect(async () => {
    await page
      .locator('[data-testid="rename-binary"][data-path="/logo.png"]')
      .click({ timeout: 2_000 });
    await page.getByTestId("rename-input").fill("/pics/logo.png", { timeout: 2_000 });
    await page.getByTestId("rename-input").press("Enter", { timeout: 2_000 });
    await expect(binaryRow(page, "/pics/logo.png")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(binaryRow(page, "/logo.png")).toHaveCount(0);
});

test("a binary row can be deleted via its ops", async ({ page }) => {
  await bootEditor(page, "bin-delete");
  await pickFile(page, "logo.png");
  await expect(binaryRow(page, "/logo.png")).toBeVisible({ timeout: 30_000 });

  await expect(async () => {
    await page
      .locator('[data-testid="delete-binary"][data-path="/logo.png"]')
      .click({ timeout: 2_000 });
    await expect(binaryRow(page, "/logo.png")).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
});

test("the preview modal shows a PNG and downloads its exact bytes", async ({ page }) => {
  await bootEditor(page, "bin-preview");
  await pickFile(page, "logo.png");
  await expect(binaryRow(page, "/logo.png")).toBeVisible({ timeout: 30_000 });

  // Clicking the row label opens the preview (never the editor). Retry — a
  // recompile can detach the row between locate and click.
  await expect(async () => {
    await binaryRow(page, "/logo.png").click({ timeout: 2_000 });
    await expect(page.getByTestId("binary-preview")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("binary-preview-image")).toBeVisible({ timeout: 30_000 });

  // Download yields a real PNG (the 8-byte signature proves the exact bytes).
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("binary-preview-download").click(),
  ]);
  const path = await download.path();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
});

test("a viewer sees a synced row but no ops, receives the image bytes over D1 blob-sync, and can't paste", async ({
  browser,
}) => {
  const ctxHost = await browser.newContext();
  const ctxViewer = await browser.newContext();
  try {
    // Host uploads an image, then shares a VIEWER link.
    const host = await ctxHost.newPage();
    await bootEditor(host, "bin-viewer");
    await host.getByTestId("upload-binary-input").setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await expect(binaryRow(host, "/logo.png")).toBeVisible({ timeout: 30_000 });

    await host.getByTestId("share-button").click();
    await expect(host.getByTestId("share-link")).toBeVisible({ timeout: 30_000 });
    await host.getByTestId("share-role-viewer").check();
    const viewerUrl = await host.getByTestId("share-link").inputValue();
    expect(new URL(viewerUrl).searchParams.get("role")).toBe("viewer");

    // Viewer joins: the binary POINTER syncs over the relay (row shows) and every
    // mutating affordance is gone. The host uploaded the image (a trusted local
    // action → servable) and stays online, so D1 blob-sync now DELIVERS the bytes
    // to the viewer (role gates mutation, not pulling a shared image to render).
    const viewer = await ctxViewer.newPage();
    await viewer.goto(viewerUrl);
    await expect(viewer.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await viewer.getByTestId("join-name-submit").click();
    await expect(viewer.getByTestId("open-library")).toBeVisible({ timeout: 30_000 });
    await openFilesDock(viewer);

    await expect(binaryRow(viewer, "/logo.png")).toBeVisible({ timeout: 30_000 });
    await expect(viewer.getByTestId("upload-binary")).toHaveCount(0);
    await expect(viewer.getByTestId("upload-binary-input")).toHaveCount(0);
    await expect(viewer.getByTestId("rename-binary")).toHaveCount(0);
    await expect(viewer.getByTestId("download-binary")).toHaveCount(0);
    await expect(viewer.getByTestId("delete-binary")).toHaveCount(0);

    // The viewer opens the preview; once D1 delivers the bytes it renders the REAL
    // image (not the "missing" state) with Download enabled. The preview resolves
    // bytes once per open, so RE-OPEN across the want-list → serve round trip until
    // the image is present.
    await expect(async () => {
      if (await viewer.getByTestId("binary-preview").isVisible()) {
        await viewer.getByTestId("binary-preview-close").click();
        await expect(viewer.getByTestId("binary-preview")).toBeHidden();
      }
      await binaryRow(viewer, "/logo.png").click({ timeout: 2_000 });
      await expect(viewer.getByTestId("binary-preview")).toBeVisible({ timeout: 2_000 });
      await expect(viewer.getByTestId("binary-preview-image")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect(viewer.getByTestId("binary-preview-download")).toBeEnabled();
    await viewer.getByTestId("binary-preview-close").click();

    // A read-only viewer's paste is inert — no upload, no new row.
    await viewer.locator('[data-testid="editor"] .cm-content').evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "clip.png", { type: "image/png" }));
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, PNG_B64);
    await viewer.waitForTimeout(500);
    await expect(binaryRow(viewer, "/pasted-image.png")).toHaveCount(0);
  } finally {
    await ctxHost.close();
    await ctxViewer.close();
  }
});
