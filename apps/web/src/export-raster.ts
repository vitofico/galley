/**
 * Roadmap #17.5 (raster off-ramp) — turn the rendered document into shareable
 * PNG bytes. "Share an image of my page."
 *
 * RENDER PATH. The compiler exposes only an SVG render (`Compiler.render` →
 * `RenderResult.pages[0].svg`, a SINGLE combined `<svg class="typst-doc">` that
 * stacks every document page; see packages/compiler/src/typst-engine.ts). It has
 * no PNG/canvas/HTML target on this typst.ts version, and the compiler/shared
 * packages are frozen — so we rasterize that SVG in the browser via the
 * native `Image`/canvas → `toBlob('image/png')` path. No new dependency.
 *
 * TESTABILITY. The browser-only canvas step is isolated behind a thin injected
 * seam ({@link RasterizeDeps.rasterize}). Everything else here is PURE and
 * unit-tested in the node gate:
 *   - {@link splitSvgPages}     — combined typst-doc SVG → per-page standalone SVGs
 *   - {@link pngPageName}       — honest `page-N.png` filenames
 *   - {@link planRasterExport}  — single-`.png` vs `.tar`-of-pages decision
 *   - {@link packPngTar}        — deterministic ustar of the page PNGs (reuses
 *                                 `@galley/collab` `writeUstar` — no new tar code)
 *
 * Output is READ-ONLY: nothing is appended to the document.
 */
import { writeUstar } from "@galley/collab";

/** Default raster scale: 2× the document's point box → crisp on HiDPI. */
export const DEFAULT_RASTER_SCALE = 2;

/** A single page lifted out of the combined SVG, ready to rasterize. */
export interface RasterPage {
  /** 0-based page index in document order. */
  index: number;
  /** A standalone, self-contained `<svg>` cropped to just this page. */
  svg: string;
  /** Page width in document points (typst pt = 1/72in). */
  widthPt: number;
  /** Page height in document points. */
  heightPt: number;
}

/** The browser-only seam: rasterize ONE standalone SVG to PNG bytes. */
export interface RasterizeDeps {
  /**
   * Turn a standalone `<svg>` string into PNG bytes at the given pixel size.
   * The only impure step; injected so the pure planning/packing logic above is
   * fully unit-testable and this is exercised by the e2e instead.
   */
  rasterize: (svg: string, widthPx: number, heightPx: number) => Promise<Uint8Array>;
}

/**
 * The chosen output for a raster export: either a single PNG (one-page doc) or a
 * tar of `page-N.png` files (multi-page). PURE shape — no bytes yet.
 */
export type RasterPlan =
  | { kind: "png"; filename: string }
  | { kind: "tar"; filename: string; pageNames: string[] };

/**
 * Honest, 1-based page filename: `page-1.png`, `page-2.png`, …. Stable
 * zero-free numbering so a 3-page doc never produces a misleading `page-0`.
 */
export function pngPageName(index0: number): string {
  return `page-${index0 + 1}.png`;
}

/**
 * Decide the output shape from a page count. One page → a single `<base>.png`;
 * more than one → `<base>.tar` packing `page-1.png …`. `base` defaults to the
 * conventional document stem. PURE.
 */
export function planRasterExport(pageCount: number, base = "document"): RasterPlan {
  if (pageCount <= 1) {
    return { kind: "png", filename: `${base}.png` };
  }
  const pageNames = Array.from({ length: pageCount }, (_, i) => pngPageName(i));
  return { kind: "tar", filename: `${base}-pages.tar`, pageNames };
}

/**
 * Pack per-page PNG byte arrays into a deterministic tar, reusing the project
 * bundle's `writeUstar`. Entries are named `page-1.png …` in page order. PURE
 * (given the bytes). Throws if the name/byte counts disagree (programmer error).
 */
export function packPngTar(pngs: Uint8Array[]): Uint8Array {
  return writeUstar(
    pngs.map((bytes, i) => ({ type: "file" as const, path: pngPageName(i), bytes })),
  );
}

// --- SVG page splitting (PURE) ----------------------------------------------
//
// The combined render is `<svg class="typst-doc" viewBox="0 0 W H"> … </svg>`
// whose direct children are shared `<defs>`/`<style>` plus one
// `<g class="typst-page" transform="translate(x, y)" data-page-width data-page-height>`
// per document page (typst.ts SVG layout; see preview-source-map.ts and its
// SVG_FIXTURE). To rasterize a single page we keep the shared root attrs +
// shared defs/style and emit a standalone `<svg>` whose viewBox is translated to
// that page's box. We don't reposition the page group — instead the per-page
// viewBox is `(x, y, pageW, pageH)`, which crops the (still translate(x,y))
// group to exactly its own box.

interface ParsedPageGroup {
  /** The full `<g class="typst-page" …>…</g>` markup, verbatim. */
  markup: string;
  x: number;
  y: number;
  widthPt: number;
  heightPt: number;
}

/** Read the opening `<svg …>`'s attribute text (everything before the first `>`). */
function svgOpenAttrs(svg: string): string | null {
  const m = /<svg\b([^>]*)>/i.exec(svg);
  return m ? m[1]! : null;
}

/**
 * Collect every `xmlns`/`xmlns:*` declaration from an `<svg>`'s attribute text,
 * space-joined, so a per-page standalone SVG keeps ALL of the root's namespaces
 * (notably `xmlns:xlink`, used by `<use>`/`<a>` hrefs). Falls back to the SVG
 * default namespace when the root declares none. PURE.
 */
function namespaceDecls(attrs: string): string {
  const found = attrs.match(/\bxmlns(?::[\w-]+)?="[^"]*"/g);
  if (found && found.length > 0) return found.join(" ");
  return 'xmlns="http://www.w3.org/2000/svg"';
}

/** Pull a `width`/`height`-style numeric attribute out of an attribute string. */
function numAttr(attrs: string, name: string): number | null {
  const m = new RegExp(`\\b${name}="([\\d.]+)"`).exec(attrs);
  return m ? Number(m[1]) : null;
}

/** Parse the root viewBox `"minX minY W H"` from the combined SVG, if present. */
function rootViewBox(svg: string): { w: number; h: number } | null {
  const attrs = svgOpenAttrs(svg);
  if (!attrs) return null;
  const m = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/.exec(attrs);
  if (!m) return null;
  return { w: Number(m[3]), h: Number(m[4]) };
}

/** Extract the shared, non-page children (defs/style/etc.) of the root svg. */
function sharedDefs(svg: string): string {
  // Everything between the root <svg …> and </svg>, with every typst-page group
  // removed, is the shared prelude (defs, style, gradients) referenced by glyph
  // <use>s on every page.
  const inner = innerSvg(svg);
  return inner.replace(PAGE_GROUP_RE, "").trim();
}

/**
 * Sanitize the live preview SVG so it loads as a STANDALONE image and rasterizes
 * cleanly onto a canvas. PURE. Three transforms, each load-bearing:
 *
 *  1. Strip `<foreignObject>…</foreignObject>`. typst.ts embeds an invisible HTML
 *     overlay per text run (the `tsel` selection/source-map layer) — the VISIBLE
 *     glyphs are `<path>`/`<use>` referencing the shared `<defs>`, so dropping the
 *     overlays doesn't change the rendered image. Drawing an SVG that contains a
 *     `<foreignObject>` (arbitrary HTML) onto a canvas TAINTS it, so a later
 *     `toBlob`/`getImageData` throws a SecurityError.
 *  2. Strip `<script>…</script>`. typst.ts injects an interaction script; an
 *     Image-loaded SVG never runs it, and a static page image doesn't want it.
 *  3. Replace the bare HTML entity `&nbsp;` with its XML-defined numeric form
 *     `&#160;`. A standalone SVG is parsed as STRICT XML (image/svg+xml), where
 *     `&nbsp;` is undefined and aborts the whole parse — the live in-DOM SVG only
 *     survives it because the HTML parser predefines the entity. This is the
 *     entity that blocks the typst SVG; we normalize it without touching glyphs.
 *
 * The result renders byte-for-byte the same page, minus the invisible overlay.
 */
export function stripForeignObjects(svg: string): string {
  return svg
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/&nbsp;/g, "&#160;");
}

/** Inner markup of the root `<svg>…</svg>`. */
function innerSvg(svg: string): string {
  const open = svg.indexOf(">", svg.search(/<svg\b/i));
  const close = svg.lastIndexOf("</svg>");
  if (open < 0 || close < 0 || close < open) return "";
  return svg.slice(open + 1, close);
}

// A typst-page group with its translate offset and document-space size. The
// `[\s\S]*?` body is non-greedy so sibling page groups don't get swallowed; the
// groups are leaf-balanced in typst.ts output (one closing </g> per page group's
// own open is matched by reaching the next page group or end — we rely on the
// data-page-* attrs + the well-formed single-line-ish structure typst emits).
const PAGE_GROUP_RE =
  /<g class="typst-page"[^>]*?transform="translate\(([-\d.]+),\s*([-\d.]+)\)"[^>]*?data-page-width="([\d.]+)"[^>]*?data-page-height="([\d.]+)"[^>]*?>([\s\S]*?)(?=<g class="typst-page"|$)/g;

/**
 * Split the combined typst-doc SVG into standalone per-page SVGs. Each result is
 * a self-contained `<svg>` carrying the shared defs/style and exactly one page
 * group, with a viewBox cropped to that page's box.
 *
 * Fail-soft: if no page groups can be located (an unexpected SVG shape, or a
 * server-compiled SVG), returns a SINGLE entry wrapping the whole SVG sized by
 * its root viewBox — so the export still produces one honest PNG of the document
 * rather than nothing.
 */
export function splitSvgPages(svg: string): RasterPage[] {
  const openAttrs = svgOpenAttrs(svg);
  if (openAttrs === null) return [];

  // Scan the ROOT'S INNER markup (not the whole string) so the last page group's
  // `(?=…|$)` terminator stops at the end of the children — never swallowing the
  // root's closing `</svg>` (which would yield a nested, malformed page SVG).
  const inner = innerSvg(svg);
  const groups: ParsedPageGroup[] = [];
  PAGE_GROUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAGE_GROUP_RE.exec(inner)) !== null) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const widthPt = Number(m[3]);
    const heightPt = Number(m[4]);
    // Re-slice the full group markup including its open tag (the captured body
    // in m[5] omits the `</g>`s; we re-extract from the match start to its end).
    const markup = m[0];
    groups.push({ markup, x, y, widthPt, heightPt });
  }

  // Fail-soft fallback: no recognizable page groups → one PNG of the whole doc.
  if (groups.length === 0) {
    const vb = rootViewBox(svg);
    const whole: RasterPage = {
      index: 0,
      // Strip foreignObjects even on the fallback so the whole-doc PNG doesn't
      // taint the canvas (see stripForeignObjects).
      svg: stripForeignObjects(svg),
      widthPt: vb?.w ?? numAttr(openAttrs, "width") ?? 0,
      heightPt: vb?.h ?? numAttr(openAttrs, "height") ?? 0,
    };
    return [whole];
  }

  // Strip the canvas-tainting foreignObjects up front (see stripForeignObjects);
  // they live in both the shared defs and the page groups.
  const defs = stripForeignObjects(sharedDefs(svg));
  // Preserve the root's namespace/class attrs but force a per-page viewBox +
  // explicit size so each rasterized page is exactly its own box. We carry over
  // EVERY `xmlns`/`xmlns:*` declaration from the root (typst's SVG uses
  // `xmlns:xlink` for `<use>`/`<a>` hrefs and `xmlns:h5`); a standalone SVG is
  // parsed as strict XML, so a dropped namespace prefix aborts the whole parse.
  const ns = namespaceDecls(openAttrs);
  const rootClass = /class="([^"]*)"/.exec(openAttrs)?.[1] ?? "typst-doc";

  return groups.map((g, index) => {
    const viewBox = `${g.x} ${g.y} ${g.widthPt} ${g.heightPt}`;
    const pageSvg =
      `<svg ${ns} class="${rootClass}" ` +
      `viewBox="${viewBox}" width="${g.widthPt}" height="${g.heightPt}">` +
      defs +
      stripForeignObjects(g.markup) +
      `</svg>`;
    return { index, svg: pageSvg, widthPt: g.widthPt, heightPt: g.heightPt };
  });
}

// --- Orchestration (uses the injected seam) ---------------------------------

/** Result of a raster export: the suggested filename + the bytes to download. */
export interface RasterExport {
  filename: string;
  bytes: Uint8Array;
  /** MIME type for the download blob (`image/png` or `application/x-tar`). */
  type: string;
}

/**
 * Build the PNG (or tar-of-PNGs) export from the compiled SVG. Splits the doc
 * into pages (pure), rasterizes each via the injected seam, then packs per the
 * single-vs-tar plan (pure). `scale` controls the output resolution.
 *
 * Throws if the SVG yields no pages (nothing rendered) so the caller can surface
 * it rather than silently downloading an empty file.
 */
export async function buildRasterExport(
  svg: string,
  deps: RasterizeDeps,
  opts?: { scale?: number; base?: string },
): Promise<RasterExport> {
  const scale = opts?.scale ?? DEFAULT_RASTER_SCALE;
  const base = opts?.base ?? "document";
  const pages = splitSvgPages(svg);
  if (pages.length === 0) {
    throw new Error("raster export: nothing to rasterize (empty render)");
  }

  const pngs: Uint8Array[] = [];
  for (const page of pages) {
    const widthPx = Math.max(1, Math.round(page.widthPt * scale));
    const heightPx = Math.max(1, Math.round(page.heightPt * scale));
    pngs.push(await deps.rasterize(page.svg, widthPx, heightPx));
  }

  const plan = planRasterExport(pngs.length, base);
  if (plan.kind === "png") {
    return { filename: plan.filename, bytes: pngs[0]!, type: "image/png" };
  }
  return { filename: plan.filename, bytes: packPngTar(pngs), type: "application/x-tar" };
}

/**
 * The production rasterize seam: draw a standalone SVG onto a canvas via an
 * `Image` loaded from a blob URL, then read it back as PNG bytes. Browser-only
 * (uses `Image`, `document`, `canvas`); covered by the e2e, not jsdom.
 */
export async function browserRasterize(
  svg: string,
  widthPx: number,
  heightPx: number,
): Promise<Uint8Array> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("raster export: 2D canvas context unavailable");
    // White backdrop: PNG over a transparent canvas would make page margins see-
    // through, which reads wrong for a "picture of my page".
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.drawImage(img, 0, 0, widthPx, heightPx);
    const out = await canvasToPng(canvas);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Promise wrapper around `Image` load from a (blob) URL. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("raster export: SVG image failed to load"));
    img.src = url;
  });
}

/** Read a canvas back as PNG bytes via `toBlob`. */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("raster export: canvas.toBlob produced no PNG"));
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject);
    }, "image/png");
  });
}
