import { describe, it, expect, beforeEach } from "vitest";
import {
  FILES_DOCK_PREF_KEY,
  readFilesDockPref,
  writeFilesDockPref,
} from "./files-dock-pref.js";

/** A minimal in-memory localStorage stand-in for the jsdom-free path. */
function installMemoryStorage(): void {
  const map = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("files-dock-pref", () => {
  beforeEach(() => installMemoryStorage());

  it("returns null when no choice has been recorded", () => {
    expect(readFilesDockPref()).toBeNull();
  });

  it("round-trips an explicit CLOSED choice", () => {
    writeFilesDockPref(true);
    expect(localStorage.getItem(FILES_DOCK_PREF_KEY)).toBe("closed");
    expect(readFilesDockPref()).toBe(true);
  });

  it("round-trips an explicit OPEN choice", () => {
    writeFilesDockPref(false);
    expect(localStorage.getItem(FILES_DOCK_PREF_KEY)).toBe("open");
    expect(readFilesDockPref()).toBe(false);
  });

  it("treats an unrecognized stored value as no choice", () => {
    localStorage.setItem(FILES_DOCK_PREF_KEY, "maybe");
    expect(readFilesDockPref()).toBeNull();
  });
});
