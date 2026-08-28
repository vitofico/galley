import { describe, it, expect, beforeEach } from "vitest";
import {
  ZOOM_STORAGE_KEY,
  ZOOM_DEFAULT,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  clampZoom,
  zoomIn,
  zoomOut,
  isActualSize,
  parseStoredZoom,
  readStoredZoom,
  writeStoredZoom,
} from "./preview-zoom.js";

describe("clampZoom", () => {
  it("keeps in-range values (rounded)", () => {
    expect(clampZoom(100)).toBe(100);
    expect(clampZoom(137.4)).toBe(137);
    expect(clampZoom(137.6)).toBe(138);
  });
  it("clamps below min and above max", () => {
    expect(clampZoom(10)).toBe(ZOOM_MIN);
    expect(clampZoom(9999)).toBe(ZOOM_MAX);
  });
  it("falls back to default for non-finite input", () => {
    expect(clampZoom(NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Infinity)).toBe(ZOOM_DEFAULT); // non-finite -> default
    expect(clampZoom(-Infinity)).toBe(ZOOM_DEFAULT);
  });
});

describe("zoomIn / zoomOut", () => {
  it("steps by ZOOM_STEP", () => {
    expect(zoomIn(100)).toBe(100 + ZOOM_STEP);
    expect(zoomOut(100)).toBe(100 - ZOOM_STEP);
  });
  it("clamps at the boundaries", () => {
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });
});

describe("isActualSize", () => {
  it("is true only at the default", () => {
    expect(isActualSize(100)).toBe(true);
    expect(isActualSize(125)).toBe(false);
    expect(isActualSize(75)).toBe(false);
  });
});

describe("parseStoredZoom", () => {
  it("returns default for null/undefined/garbage", () => {
    expect(parseStoredZoom(null)).toBe(ZOOM_DEFAULT);
    expect(parseStoredZoom(undefined)).toBe(ZOOM_DEFAULT);
    expect(parseStoredZoom("not-a-number")).toBe(ZOOM_DEFAULT);
  });
  it("parses + clamps valid numeric strings", () => {
    expect(parseStoredZoom("150")).toBe(150);
    expect(parseStoredZoom("5")).toBe(ZOOM_MIN);
    expect(parseStoredZoom("1000")).toBe(ZOOM_MAX);
  });
});

// The root vitest env is "node" (no DOM), so provide a tiny localStorage stub.
// The helpers guard on `typeof localStorage === "undefined"`, so we install a
// real-enough shim on globalThis to exercise the persistence path directly.
function installLocalStorageStub(): Record<string, string> {
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
  return store;
}

describe("localStorage round-trip", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });
  it("defaults when nothing stored", () => {
    expect(readStoredZoom()).toBe(ZOOM_DEFAULT);
  });
  it("persists and restores", () => {
    writeStoredZoom(175);
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("175");
    expect(readStoredZoom()).toBe(175);
  });
  it("clamps on write", () => {
    writeStoredZoom(99999);
    expect(readStoredZoom()).toBe(ZOOM_MAX);
  });
});
