import { describe, it, expect } from "vitest";
import type { ProviderConfig } from "@galley/shared";
import {
  PROVIDER_KEY,
  loadStoredProvider,
  saveStoredProvider,
  clearStoredProvider,
  type ProviderStorage,
} from "./provider-storage.js";

/** Map-backed fake of the storage slice (the Node gate has no localStorage). */
function fakeStorage(seed?: Record<string, string>): ProviderStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const CONFIG: ProviderConfig = {
  kind: "openai-compatible",
  label: "My provider",
  baseUrl: "https://api.example.test/v1",
  model: "gpt-test",
  isLocal: false,
  transport: { mode: "direct", apiKey: "sk-local-only" },
};

describe("provider-storage", () => {
  it("pins the legacy shell's storage key, so both shells share one config", () => {
    // App.tsx has always persisted under this exact key; the seam MUST match it
    // or a provider configured in one shell would go dark in the other.
    expect(PROVIDER_KEY).toBe("galley.provider");
  });

  it("round-trips a config through save → load", () => {
    const store = fakeStorage();
    saveStoredProvider(CONFIG, store);
    expect(store.map.has(PROVIDER_KEY)).toBe(true);
    expect(loadStoredProvider(store)).toEqual(CONFIG);
  });

  it("reads a config persisted by the LEGACY shell (raw JSON under the same key)", () => {
    // Byte-shape compatibility: App.tsx does a plain JSON.stringify of the config.
    const store = fakeStorage({ [PROVIDER_KEY]: JSON.stringify(CONFIG) });
    expect(loadStoredProvider(store)).toEqual(CONFIG);
  });

  it("returns null when nothing is stored", () => {
    expect(loadStoredProvider(fakeStorage())).toBeNull();
  });

  it("fails soft (null) on malformed or shape-less stored values", () => {
    expect(loadStoredProvider(fakeStorage({ [PROVIDER_KEY]: "{not json" }))).toBeNull();
    expect(loadStoredProvider(fakeStorage({ [PROVIDER_KEY]: '"just a string"' }))).toBeNull();
    expect(loadStoredProvider(fakeStorage({ [PROVIDER_KEY]: "42" }))).toBeNull();
    expect(loadStoredProvider(fakeStorage({ [PROVIDER_KEY]: '{"label":"no kind"}' }))).toBeNull();
  });

  it("clearStoredProvider removes the stored config (Use Demo)", () => {
    const store = fakeStorage();
    saveStoredProvider(CONFIG, store);
    clearStoredProvider(store);
    expect(loadStoredProvider(store)).toBeNull();
    expect(store.map.has(PROVIDER_KEY)).toBe(false);
  });

  it("swallows storage write failures (quota / private mode)", () => {
    const store: ProviderStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveStoredProvider(CONFIG, store)).not.toThrow();
    expect(() => clearStoredProvider(store)).not.toThrow();
  });
});
