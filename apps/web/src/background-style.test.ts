import { afterEach, expect, it, vi } from "vitest";
import {
  BACKGROUND_STORAGE_KEY,
  readBackgroundStyle,
  resolveBackgroundStyle,
  setBackgroundStyle,
} from "./background-style.js";

afterEach(() => vi.unstubAllGlobals());

it("defaults to artwork and retains an explicit plain choice", () => {
  expect(resolveBackgroundStyle(null)).toBe("artwork");
  expect(resolveBackgroundStyle("unknown")).toBe("artwork");
  expect(resolveBackgroundStyle("plain")).toBe("plain");
});

it("persists the background choice without replacing skin or mode", () => {
  const dataset = { skin: "press", theme: "dark", backgroundStyle: "artwork" };
  const storage = new Map([
    ["galley.skin", "press"],
    ["galley.theme", "dark"],
  ]);
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  setBackgroundStyle("plain");
  expect(readBackgroundStyle()).toBe("plain");
  expect(dataset).toEqual({
    skin: "press",
    theme: "dark",
    backgroundStyle: "plain",
  });
  expect(storage.get(BACKGROUND_STORAGE_KEY)).toBe("plain");
  expect(storage.get("galley.skin")).toBe("press");
  expect(storage.get("galley.theme")).toBe("dark");
});

it("keeps the current session usable when persistence is blocked", () => {
  const dataset: Record<string, string> = {};
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => {
      throw new Error("storage blocked");
    },
  });
  expect(readBackgroundStyle()).toBe("artwork");
  expect(() => setBackgroundStyle("plain")).not.toThrow();
  expect(dataset.backgroundStyle).toBe("plain");
});
