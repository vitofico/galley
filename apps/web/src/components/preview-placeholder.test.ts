import { describe, expect, it } from "vitest";
import { previewPlaceholder } from "./preview-placeholder.js";

describe("previewPlaceholder", () => {
  it("shows the loading text until the compiler is ready", () => {
    expect(previewPlaceholder({ ready: false, errorCount: 0, busy: false, pageCount: null })).toBe(
      "Loading compiler…",
    );
    // Errors are irrelevant while still loading — loading wins.
    expect(previewPlaceholder({ ready: false, errorCount: 3, busy: false, pageCount: null })).toBe(
      "Loading compiler…",
    );
  });

  it("shows 'Compiling…' while the first compile hasn't resolved yet (pageCount null)", () => {
    // Ready, no errors, no page resolved yet → honestly still working (no flicker
    // on the fast first compile — pageCount stays null until it resolves).
    expect(previewPlaceholder({ ready: true, errorCount: 0, busy: false, pageCount: null })).toBe(
      "Compiling…",
    );
  });

  it("shows 'Compiling…' while a recompile of an empty doc is in flight (busy)", () => {
    // M10: even after a 0-page result, an in-flight recompile reads "Compiling…",
    // not the empty-state — so the busy flag (H1) drives the live cue.
    expect(previewPlaceholder({ ready: true, errorCount: 0, busy: true, pageCount: 0 })).toBe(
      "Compiling…",
    );
  });

  it("M10: a clean compile that produced NO page reads an honest empty-state, not 'Compiling…'", () => {
    // The old branch sat on "Compiling…" forever for an empty document (svg null,
    // no errors). Now, once a compile has RESOLVED to zero pages and nothing is in
    // flight, it tells the truth instead of pretending to still be working.
    expect(previewPlaceholder({ ready: true, errorCount: 0, busy: false, pageCount: 0 })).toBe(
      "Nothing to preview yet — your typeset pages appear here as you write.",
    );
  });

  it("surfaces a compile failure instead of lying with 'Compiling…'", () => {
    expect(previewPlaceholder({ ready: true, errorCount: 1, busy: false, pageCount: null })).toBe(
      "Couldn't compile — 1 error. See the diagnostics below.",
    );
    expect(previewPlaceholder({ ready: true, errorCount: 4, busy: true, pageCount: 0 })).toBe(
      "Couldn't compile — 4 errors. See the diagnostics below.",
    );
  });
});
