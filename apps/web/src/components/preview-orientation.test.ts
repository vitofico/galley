import { expect, it } from "vitest";
import { anchorY, pageAnchor } from "./preview-orientation.js";
it("keeps the same page and within-page location after page-size reflow", () => {
  const anchor = pageAnchor(1250, [1000, 1000, 1000])!;
  expect(anchor).toEqual({ page: 1, fraction: 0.25 });
  expect(anchorY(anchor, [800, 1200, 800])).toBe(1100);
});
it("clamps to the surviving last page and refuses unavailable geometry", () => {
  expect(anchorY({ page: 4, fraction: 0.5 }, [800, 800])).toBe(1200);
  expect(pageAnchor(4, [])).toBeNull();
  expect(anchorY({ page: 0, fraction: 0 }, [NaN])).toBeNull();
});
