import { describe, it, expect } from "vitest";
import { omittedBinariesNotice, exportFailureNotice } from "./export-notice.js";

describe("omittedBinariesNotice", () => {
  it("names the single dropped asset", () => {
    expect(omittedBinariesNotice(["/figs/plot.png"])).toBe(
      "Exported without 1 image whose data isn't available on this device: /figs/plot.png.",
    );
  });

  it("pluralizes and lists multiple dropped assets", () => {
    const msg = omittedBinariesNotice(["/a.png", "/b.jpg"]);
    expect(msg).toContain("2 images");
    expect(msg).toContain("/a.png, /b.jpg");
  });
});

describe("exportFailureNotice (H4)", () => {
  it("names the failed format and reassures the work is safe", () => {
    for (const kind of ["PDF", "source bundle", "git repository", "PNG"] as const) {
      const msg = exportFailureNotice(kind);
      expect(msg).toContain(`Couldn't export the ${kind}`);
      expect(msg).toMatch(/safe and unchanged/i);
    }
  });
});
