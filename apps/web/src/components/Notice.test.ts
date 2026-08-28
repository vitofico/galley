import { describe, it, expect } from "vitest";
import { noticeRole, noticeGlyph } from "./Notice.js";

describe("Notice helpers (#19.4)", () => {
  it("only errors get the interrupting alert role", () => {
    expect(noticeRole("error")).toBe("alert");
    expect(noticeRole("warning")).toBe("status");
    expect(noticeRole("info")).toBe("status");
  });

  it("every severity has a glyph", () => {
    for (const s of ["info", "warning", "error"] as const) {
      expect(noticeGlyph(s).length).toBeGreaterThan(0);
    }
  });
});
