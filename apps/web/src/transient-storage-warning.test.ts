import { describe, it, expect } from "vitest";
import {
  shouldWarnTransientStorage,
  dismissTransientWarning,
  TRANSIENT_WARNING_KEY,
  type WarningStorage,
} from "./transient-storage-warning.js";

/** A Map-backed fake of the Storage slice (the Node gate has no localStorage). */
function fakeStorage(seed: Record<string, string> = {}): WarningStorage {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("shouldWarnTransientStorage (M9)", () => {
  it("warns a transient origin that hasn't dismissed yet", () => {
    expect(shouldWarnTransientStorage("transient", fakeStorage())).toBe(true);
  });

  it("does NOT warn once dismissed (the flag persists)", () => {
    const store = fakeStorage();
    dismissTransientWarning(store);
    expect(store.getItem(TRANSIENT_WARNING_KEY)).toBe("1");
    expect(shouldWarnTransientStorage("transient", store)).toBe(false);
  });

  it("never warns a healthy / undetermined origin (additive — no false alarms)", () => {
    expect(shouldWarnTransientStorage("persisted", fakeStorage())).toBe(false);
    expect(shouldWarnTransientStorage("unsupported", fakeStorage())).toBe(false);
    expect(shouldWarnTransientStorage(null, fakeStorage())).toBe(false);
  });

  it("does not nag when storage is unavailable (a dismissal couldn't persist)", () => {
    expect(shouldWarnTransientStorage("transient", null)).toBe(false);
  });

  it("dismiss is a no-op (never throws) without storage", () => {
    expect(() => dismissTransientWarning(null)).not.toThrow();
  });
});
