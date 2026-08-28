import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

// ── Minimal stored-method zip builder (mirrors project-redesign.spec.ts) ───────
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

// A real 1×1 PNG — typst's image() decodes it (a stub wouldn't resolve). Same
// bytes the compiler engine's #7 unit test uses.
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/**
 * #7 7D end-to-end: importing a project zip that contains an IMAGE must store the
 * bytes in the per-project BlobStore, add a content-addressed binary pointer to
 * the project, show the image as a binary row in the file tree (distinct from the
 * editable text rows — its label opens the preview, never the editor), and
 * resolve the bytes into the compile input so `image("…")` renders (the project
 * compiles to pages). This drives the WHOLE chain that had zero consumers before
 * this slice; a "tab reachable" assertion alone (wave-18 lesson) would not.
 */
test("a zip import with an image stores it, shows a binary row, and compiles", async ({
  page,
}) => {
  // Project import lives on the Projects page now (a zip is usually a project).
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });

  // An Overleaf-style zip: a main.tex drawing the bundled image, + the PNG. A
  // `figure` float with `\includegraphics{logo.png}` converts to a Typst
  // `#figure(image("logo.png"))`, which resolves against /main.typ → /logo.png in
  // the VFS the binary channel feeds.
  const zip = buildStoredZip([
    {
      name: "main.tex",
      data: new TextEncoder().encode(
        "\\documentclass{article}\n\\begin{document}\n" +
          "Imported with an image.\n\n" +
          "\\begin{figure}\n\\includegraphics{logo.png}\n\\caption{A figure}\n\\end{figure}\n" +
          "\\end{document}\n",
      ),
    },
    { name: "logo.png", data: PNG },
  ]);

  // Open "Import project", pick the archive, accept.
  await page.getByTestId("library-import-project").click();
  await expect(page.getByTestId("project-import-panel")).toBeVisible();
  await page.getByTestId("import-project-file").setInputFiles({
    name: "Illustrated.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  await expect(page.getByTestId("import-project-accept")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("import-project-accept").click();

  // The new project opened.
  await expect(page).toHaveURL(/\/p\//, { timeout: 30_000 });
  await expect(page.getByTestId("project-name")).toHaveText("Illustrated", { timeout: 30_000 });
  await openFilesDock(page);

  // The image appears as a binary row at /logo.png (proves:
  // blobStore.put → createBinary → snapshot.binaryFiles → file tree).
  const binaryRow = page.locator('[data-testid="project-binary-file"][data-path="/logo.png"]');
  await expect(binaryRow).toBeVisible({ timeout: 30_000 });

  // The binary row never opens the editor: it is not the editable file button.
  await expect(
    page.locator('[data-testid="project-file"][data-path="/logo.png"]'),
  ).toHaveCount(0);

  // The project compiles to at least one page — the image() resolves because the
  // bytes were fetched from the BlobStore into the compile input. (A missing
  // binary channel would error on the unresolved image and never reach pages.)
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
});
