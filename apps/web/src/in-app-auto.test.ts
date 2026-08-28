import { describe, it, expect } from "vitest";
import { decideInAppAuto, passesInAppFinalGate } from "./in-app-auto.js";

/**
 * The in-app auto-apply decision (ADR-0025 §4) is a pure policy: auto-apply ONLY
 * when the project is in Auto mode AND the local role can mutate. Everything else
 * — Ask mode, or a viewer who cannot apply at all — falls back to the Ask gate.
 */
describe("decideInAppAuto", () => {
  it("auto + canMutate ⇒ autoApply true", () => {
    expect(decideInAppAuto({ mode: "auto", canMutate: true })).toEqual({ autoApply: true });
  });

  it("auto + viewer (canMutate false) ⇒ autoApply false", () => {
    expect(decideInAppAuto({ mode: "auto", canMutate: false })).toEqual({ autoApply: false });
  });

  it("ask + canMutate ⇒ autoApply false", () => {
    expect(decideInAppAuto({ mode: "ask", canMutate: true })).toEqual({ autoApply: false });
  });

  it("ask + viewer ⇒ autoApply false", () => {
    expect(decideInAppAuto({ mode: "ask", canMutate: false })).toEqual({ autoApply: false });
  });
});

/**
 * The in-app FINAL pre-apply gate (H2) — re-read LIVE after the checkpoint window.
 * Auto + canMutate + no-conflict ⇒ apply; ANY other combination ⇒ fall back to the
 * Ask gate. (The seam supplies the live re-reads; this just pins the policy.)
 */
describe("passesInAppFinalGate", () => {
  const green = { mode: "auto", canMutate: true, conflict: false } as const;

  it("auto + canMutate + no conflict ⇒ apply", () => {
    expect(passesInAppFinalGate(green)).toBe(true);
  });

  it("a flip to Ask during the checkpoint window ⇒ fall back", () => {
    expect(passesInAppFinalGate({ ...green, mode: "ask" })).toBe(false);
  });

  it("a role drop to viewer (canMutate false) ⇒ fall back", () => {
    expect(passesInAppFinalGate({ ...green, canMutate: false })).toBe(false);
  });

  it("a concurrent edit (conflict) ⇒ fall back", () => {
    expect(passesInAppFinalGate({ ...green, conflict: true })).toBe(false);
  });
});
