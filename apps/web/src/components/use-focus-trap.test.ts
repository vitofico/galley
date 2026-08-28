import { describe, it, expect } from "vitest";
import { nextTrapFocus, FOCUSABLE_SELECTOR } from "./use-focus-trap.js";

/**
 * Pure-core tests for the focus-trap hook (#23.5 a11y). The hook itself binds a
 * `keydown` listener and reads the live DOM, but its DECISION — where Tab /
 * Shift-Tab should redirect focus to keep it inside the dialog — is a pure
 * function over the ordered focusable list + the currently-focused element. We
 * test that, with plain stand-in objects, so the gate stays in the `node`
 * environment with no jsdom (the repo's test layer).
 *
 * Contract for `nextTrapFocus(focusables, active, shift)`:
 *   - Tab on the LAST element wraps to the FIRST.
 *   - Shift-Tab on the FIRST element wraps to the LAST.
 *   - Anywhere in the MIDDLE, the browser's native order is fine → null (no
 *     redirect — never fight the native traversal).
 *   - Focus currently OUTSIDE the dialog (e.g. escaped to the page) → pull it to
 *     the first (Tab) or last (Shift-Tab) so the trap re-captures it.
 *   - An EMPTY focusable list → null (nothing to focus; caller no-ops).
 *   - A SINGLE focusable → it always stays focused (wrap to itself).
 */

// Minimal stand-ins: identity-comparable tokens standing in for DOM elements.
const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };

describe("nextTrapFocus", () => {
  it("Tab on the last element wraps to the first", () => {
    expect(nextTrapFocus([a, b, c], c, false)).toBe(a);
  });

  it("Shift-Tab on the first element wraps to the last", () => {
    expect(nextTrapFocus([a, b, c], a, true)).toBe(c);
  });

  it("Tab in the middle does not redirect (native order is correct)", () => {
    expect(nextTrapFocus([a, b, c], b, false)).toBeNull();
    expect(nextTrapFocus([a, b, c], a, false)).toBeNull();
  });

  it("Shift-Tab in the middle does not redirect", () => {
    expect(nextTrapFocus([a, b, c], b, true)).toBeNull();
    expect(nextTrapFocus([a, b, c], c, true)).toBeNull();
  });

  it("focus escaped outside the dialog is pulled back to the first on Tab", () => {
    const outsider = { id: "outsider" };
    expect(nextTrapFocus([a, b, c], outsider, false)).toBe(a);
  });

  it("focus escaped outside the dialog is pulled back to the last on Shift-Tab", () => {
    const outsider = { id: "outsider" };
    expect(nextTrapFocus([a, b, c], outsider, true)).toBe(c);
  });

  it("an empty focusable list never redirects", () => {
    expect(nextTrapFocus([], a, false)).toBeNull();
    expect(nextTrapFocus([], a, true)).toBeNull();
  });

  it("a single focusable wraps to itself in both directions", () => {
    expect(nextTrapFocus([a], a, false)).toBe(a);
    expect(nextTrapFocus([a], a, true)).toBe(a);
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("targets the standard interactive elements and excludes disabled/-1 tabindex", () => {
    // The selector is the contract the hook queries with; pin its shape so a
    // future edit that drops (say) textarea or the disabled-exclusion is caught.
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("textarea:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("input:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("a[href]");
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
