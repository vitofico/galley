import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

// ── Minimal stored-method zip builder (test-only, mirrors import-real-zip.test) ─
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildStoredZip(entries: { name: string; data: Uint8Array }[]): Buffer {
  const te = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = te.encode(name);
    const crc = crc32(data);
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);
    chunks.push(lfh, data);
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);
    central.push(cdh);
    offset += lfh.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, at);
    at += c.length;
  }
  return Buffer.from(out);
}

/**
 * Project-model redesign (spec 2026-06-14) end-to-end:
 *   §1/§4 — a fresh `/` boot is the BLANK starter with a friendly, non-"Untitled"
 *           random name (NOT the Einstein desk).
 *   §2    — creating a second project and switching shows two DIFFERENT file sets.
 *   §3    — a zip import lands in its OWN new project; the prior one is unchanged.
 *   §5    — click-to-rename in the header persists across a reload + in /library.
 */

test("§1/§4 fresh boot is the blank starter with a non-Untitled random name", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Blank starter: exactly one /main.typ, NOT the seven-file Einstein desk.
  await expect(page.getByTestId("project-file")).toHaveCount(1);
  await expect(page.locator('[data-testid="project-file"][data-path="/main.typ"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/relativity.typ"]'),
  ).toHaveCount(0);

  // The header name is a friendly random name, never the old "Untitled project".
  const nameBtn = page.getByTestId("project-name");
  await expect(nameBtn).toBeVisible({ timeout: 30_000 });
  await expect(nameBtn).not.toHaveText("Untitled project");
  await expect(nameBtn).toHaveText(/^[a-z]+-[a-z]+$/);
});

test("§2 creating a second project and switching swaps the visible file set", async ({ page }) => {
  // First project: blank default boot. Capture its (random) name to switch back.
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file")).toHaveCount(1);
  const firstName = (await page.getByTestId("project-name").textContent())!;

  // Create a SECOND project via the library.
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("new-project-tile").click();
  await page.getByTestId("new-project-name").fill("Second Project");
  await page.getByTestId("create-project").click();
  const second = page.locator('[data-testid="project-card"]', { hasText: "Second Project" });
  await expect(second).toBeVisible({ timeout: 30_000 });
  await second.getByTestId("open-project").click();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // The second project is its own blank starter — a brand-new /main.typ.
  await expect(page.getByTestId("project-file")).toHaveCount(1);
  await expect(page.getByTestId("project-name")).toHaveText("Second Project");

  // Add a file unique to this project so switching is observable.
  await page.getByTestId("new-file-path").fill("/only-in-second.typ");
  await page.getByTestId("add-file").click();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/only-in-second.typ"]'),
  ).toBeVisible();

  // Switch back to the FIRST project (by its captured name) — its tree does NOT
  // carry the second project's file.
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
  const first = page.locator('[data-testid="project-card"]', { hasText: firstName });
  await first.getByTestId("open-project").click();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-name")).toHaveText(firstName);
  await expect(
    page.locator('[data-testid="project-file"][data-path="/only-in-second.typ"]'),
  ).toHaveCount(0);
});

test("§3 a zip import lands in its OWN new project; the prior project is untouched", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file")).toHaveCount(1);
  const firstName = (await page.getByTestId("project-name").textContent())!;

  // A minimal valid Overleaf-style .zip: one main.tex.
  const zip = buildStoredZip([
    {
      name: "main.tex",
      data: new TextEncoder().encode(
        "\\documentclass{article}\n\\begin{document}\nImported Body Text\n\\end{document}\n",
      ),
    },
  ]);

  // Import lives on the Projects page now — go there and pick the archive.
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("library-import-project").click();
  await expect(page.getByTestId("project-import-panel")).toBeVisible();
  await page.getByTestId("import-project-file").setInputFiles({
    name: "My Thesis.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  await expect(page.getByTestId("import-project-accept")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("import-project-accept").click();

  // It created + opened a NEW project named from the zip filename ("My Thesis").
  await expect(page).toHaveURL(/\/p\//, { timeout: 30_000 });
  await expect(page.getByTestId("project-name")).toHaveText("My Thesis", { timeout: 30_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The ORIGINAL project still exists in the library, unchanged (still blank).
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="project-card"]', { hasText: firstName }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-card"]', { hasText: "My Thesis" }),
  ).toBeVisible();
});

test("§5 click-to-rename the header persists across reload and in the library", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("project-name")).toBeVisible({ timeout: 30_000 });

  // Click the name → edit → Enter commits.
  await page.getByTestId("project-name").click();
  const input = page.getByTestId("project-name-input");
  await expect(input).toBeVisible();
  await input.fill("My Renamed Paper");
  await input.press("Enter");
  await expect(page.getByTestId("project-name")).toHaveText("My Renamed Paper");

  // Reload → the name persists (registry-backed).
  await page.reload();
  await expect(page.getByTestId("project-name")).toHaveText("My Renamed Paper", { timeout: 30_000 });

  // The library shows the renamed project.
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="project-card"]', { hasText: "My Renamed Paper" }),
  ).toBeVisible({ timeout: 30_000 });
});

test("§5 Escape cancels a rename (reverts to the prior name)", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  const nameBtn = page.getByTestId("project-name");
  await expect(nameBtn).toBeVisible({ timeout: 30_000 });
  const original = (await nameBtn.textContent())!;

  await nameBtn.click();
  const input = page.getByTestId("project-name-input");
  await input.fill("scratch-do-not-keep");
  await input.press("Escape");
  await expect(page.getByTestId("project-name")).toHaveText(original);
});
