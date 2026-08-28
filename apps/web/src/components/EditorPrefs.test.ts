import { describe, it, expect } from "vitest";
import {
  clampFontSize,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
} from "./EditorPrefs.js";

/**
 * Unit tests for the PURE clamping helper behind the EditorPrefs panel
 * (roadmap #11.5-UI).
 *
 * The vitest env here is the default node environment — no jsdom and no
 * @testing-library is configured (see apps/web/vite.config.ts, which has no
 * `test` block, and the existing component tests which are all pure `.test.ts`).
 * So the font-size clamping logic is extracted into this exported helper and
 * tested directly; `EditorPrefs.tsx` is a thin controlled wrapper that calls it
 * in its change handler.
 *
 * Bounds mirror the editor core's normalize() in editor-prefs.ts: [8, 32].
 */

describe("clampFontSize", () => {
  it("exposes the editor's [8, 32] bounds", () => {
    expect(FONT_SIZE_MIN).toBe(8);
    expect(FONT_SIZE_MAX).toBe(32);
  });

  it("passes through an in-range value unchanged", () => {
    expect(clampFontSize(13.5)).toBe(13.5);
    expect(clampFontSize(20)).toBe(20);
  });

  it("clamps below-range values up to the minimum", () => {
    expect(clampFontSize(0)).toBe(8);
    expect(clampFontSize(7.9)).toBe(8);
    expect(clampFontSize(-100)).toBe(8);
  });

  it("clamps above-range values down to the maximum", () => {
    expect(clampFontSize(33)).toBe(32);
    expect(clampFontSize(1000)).toBe(32);
  });

  it("keeps the exact boundary values", () => {
    expect(clampFontSize(8)).toBe(8);
    expect(clampFontSize(32)).toBe(32);
  });

  it("falls back to the minimum for non-finite / NaN input", () => {
    // An empty number input parses to NaN; we must still hand the parent a
    // valid, in-range number rather than NaN.
    expect(clampFontSize(Number.NaN)).toBe(8);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(32);
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(8);
  });
});
