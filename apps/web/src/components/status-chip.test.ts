import { describe, it, expect } from "vitest";
import { statusGlyph, type StatusGlyphInputs } from "./status-chip.js";

const base: StatusGlyphInputs = {
  ready: true,
  hasInput: true,
  errorCount: 0,
  packagesUnavailable: false,
  packagesOnServer: false,
  serverActive: false,
};

describe("statusGlyph (unified status chip severity ladder)", () => {
  it("all good → calm ✓", () => {
    expect(statusGlyph(base)).toEqual({ tone: "ok", glyph: "✓" });
  });

  it("not ready wins over everything (still booting)", () => {
    expect(statusGlyph({ ...base, ready: false, errorCount: 3 }).tone).toBe("busy");
  });

  it("errors outrank package warnings and server info", () => {
    expect(
      statusGlyph({ ...base, errorCount: 1, packagesUnavailable: true, serverActive: true })
        .tone,
    ).toBe("error");
  });

  it("fail-closed packages and a missing compile input read as warnings", () => {
    expect(statusGlyph({ ...base, packagesUnavailable: true }).tone).toBe("warn");
    expect(statusGlyph({ ...base, hasInput: false }).tone).toBe("warn");
  });

  it("server involvement (egress or active server compiler) reads as info", () => {
    expect(statusGlyph({ ...base, packagesOnServer: true }).tone).toBe("info");
    expect(statusGlyph({ ...base, serverActive: true }).tone).toBe("info");
  });

  // H1 — a live recompile shows the busy ◌ cue and supersedes the stale resolved
  // glyph; a warm (non-busy) edit stays byte-for-byte calm.
  it("a recompile in flight (busy) shows the busy ◌ cue even when ready", () => {
    expect(statusGlyph({ ...base, busy: true })).toEqual({ tone: "busy", glyph: "◌" });
  });

  it("busy supersedes a stale error count (the visible preview is mid-recompile)", () => {
    expect(statusGlyph({ ...base, busy: true, errorCount: 5 }).tone).toBe("busy");
  });

  it("a warm edit (busy false / unset) is unchanged — no ◌, the resolved glyph wins", () => {
    expect(statusGlyph({ ...base, busy: false })).toEqual({ tone: "ok", glyph: "✓" });
    // omitting busy entirely is identical (optional input defaults calm)
    expect(statusGlyph(base)).toEqual({ tone: "ok", glyph: "✓" });
  });
});
