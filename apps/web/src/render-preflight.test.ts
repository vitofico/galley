import { describe, expect, it } from "vitest";
import { renderPreflight } from "./render-preflight.js";
const input = {
  source: "Ready",
  fresh: true,
  pageCount: 2,
  pages: [
    { widthPt: 595.28, heightPt: 841.89 },
    { widthPt: 595.28, heightPt: 841.89 },
  ],
  maxPages: 2,
  paper: "a4" as const,
};
describe("rendered preflight", () => {
  it("never passes a stale render, even inside the debounce window", () =>
    expect(
      renderPreflight({ ...input, fresh: false }).every(
        (c) => c.status === "unavailable",
      ),
    ).toBe(true));
  it("checks every page and editorial markers", () => {
    const checks = renderPreflight({
      ...input,
      source: "TODO [[check this]]",
      pages: [{ widthPt: 612, heightPt: 792 }, input.pages[1]!],
    });
    expect(checks.map((c) => c.status)).toEqual(["failed", "passed", "failed"]);
  });
  it("does not invent absent per-page geometry", () =>
    expect(renderPreflight({ ...input, pages: undefined })[2]?.status).toBe(
      "unavailable",
    ));
  it("rejects a page cap breach", () =>
    expect(renderPreflight({ ...input, maxPages: 1 })[1]?.status).toBe(
      "failed",
    ));
});
