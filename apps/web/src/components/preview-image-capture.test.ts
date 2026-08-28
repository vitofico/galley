import { describe, it, expect } from "vitest";
import { svgToPngDataUrl } from "./preview-image-capture.js";

/**
 * `svgToPngDataUrl` is the hand-rolled, dependency-free SVG→PNG rasterizer for
 * the #10 layout-judge capture. It is BROWSER-ONLY (Image + Canvas); in the Node
 * unit env those APIs are absent, which is precisely the FAIL-CLOSED path we pin
 * here: every guard must resolve to `null` rather than throw. The happy raster
 * path (real Canvas) is exercised at the DOM/e2e layer by the coordinator sweep.
 */
describe("svgToPngDataUrl (#10 capture, fail-closed)", () => {
  it("returns null for empty input", async () => {
    expect(await svgToPngDataUrl("")).toBeNull();
  });

  it("returns null for non-SVG markup (guards before any browser API)", async () => {
    expect(await svgToPngDataUrl("<div>not an svg</div>")).toBeNull();
    expect(await svgToPngDataUrl("just text")).toBeNull();
  });

  it("returns null for a non-string input without throwing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await svgToPngDataUrl(undefined as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await svgToPngDataUrl(null as any)).toBeNull();
  });

  it("returns null (never throws) when the browser Canvas/Image APIs are unavailable", async () => {
    // The Node unit env has no `document`/`Image`; a well-formed SVG must still
    // degrade to null instead of crashing — the consumer treats null as "could
    // not capture" and never calls the model.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`;
    await expect(svgToPngDataUrl(svg)).resolves.toBeNull();
  });

  it("accepts a scale argument without throwing on the fail-closed path", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`;
    await expect(svgToPngDataUrl(svg, 2)).resolves.toBeNull();
  });
});
