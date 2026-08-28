/**
 * Preview → PNG capture (roadmap #10 wiring) — a hand-rolled, browser-only
 * rasterizer with NO new dependencies. The vision cores (judgeLayout) want a
 * bitmap of the live preview; the preview is an inline SVG string, so we draw it
 * onto a `<canvas>` via an `Image` and read back a PNG data URL.
 *
 * FAIL-CLOSED by design: every failure mode — empty/garbage SVG, no Canvas in
 * the environment, a tainted canvas (cross-origin image refs make `toDataURL`
 * throw a SecurityError), or a load error — resolves to `null` rather than
 * throwing or returning a half-baked value. The caller treats `null` as "could
 * not capture" and never feeds it to the model.
 *
 * Pure of React; the single browser-API touch point (`Image`/`Canvas`) is what
 * keeps this out of the Node unit env, so the consumer (figure-vision-tools)
 * takes the capture as an INJECTABLE function and tests stub it.
 */

/** The capture seam the vision tools depend on. Returns a PNG data URL or null. */
export type SvgToPngCapture = (svg: string) => Promise<string | null>;

/**
 * Rasterize an inline SVG string to a PNG data URL using the browser's
 * `Image` + `Canvas`. Resolves to `null` on ANY failure (fail-closed):
 *  - missing/blank/non-SVG input,
 *  - no `Image`/`document`/Canvas-2d support,
 *  - image load error (malformed SVG),
 *  - tainted-canvas SecurityError on `toDataURL`.
 *
 * @param svg   the inline `<svg>…</svg>` markup of the live preview.
 * @param scale optional device-pixel multiplier for a crisper capture (default 1).
 */
export function svgToPngDataUrl(svg: string, scale = 1): Promise<string | null> {
  // Guard 1: input must look like SVG markup. A blank or non-SVG string can
  // never rasterize — fail closed before touching any browser API.
  if (typeof svg !== "string" || !/<svg[\s>]/i.test(svg)) {
    return Promise.resolve(null);
  }

  // Guard 2: the browser APIs must exist. In the Node unit env they don't, so a
  // direct call (rather than the injected stub) degrades to null, never a throw.
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL === "undefined"
  ) {
    return Promise.resolve(null);
  }

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let objectUrl: string | null = null;
    const cleanup = () => {
      if (objectUrl && typeof URL.revokeObjectURL === "function") {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* ignore */
        }
      }
    };

    try {
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      objectUrl = URL.createObjectURL(blob);
    } catch {
      cleanup();
      done(null);
      return;
    }

    const img = new Image();

    img.onerror = () => {
      cleanup();
      done(null);
    };

    img.onload = () => {
      try {
        const width = Math.max(1, Math.round((img.naturalWidth || img.width || 0) * scale));
        const height = Math.max(1, Math.round((img.naturalHeight || img.height || 0) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          done(null);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        // toDataURL throws a SecurityError if the canvas is tainted (e.g. the SVG
        // referenced a cross-origin raster). Fail closed on that path too.
        const url = canvas.toDataURL("image/png");
        cleanup();
        done(typeof url === "string" && url.startsWith("data:image/png") ? url : null);
      } catch {
        cleanup();
        done(null);
      }
    };

    try {
      img.src = objectUrl;
    } catch {
      cleanup();
      done(null);
    }
  });
}
