/**
 * The deploy-base seam. The load-bearing assertion here is the FIRST describe
 * in each group: at the default base ("/") every function is the IDENTITY on an
 * app-absolute path, so every root-served deployment — dev, `vite preview`, the
 * e2e gate, the Docker runtime, k8s — is byte-for-byte unchanged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeBase,
  joinBase,
  stripBaseFrom,
  deployBase,
  withBase,
  stripBase,
} from "./base.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeBase", () => {
  it("maps every root spelling to /", () => {
    expect(normalizeBase("/")).toBe("/");
    expect(normalizeBase("")).toBe("/");
    expect(normalizeBase("   ")).toBe("/");
  });

  it("supplies the leading and trailing slash", () => {
    expect(normalizeBase("galley")).toBe("/galley/");
    expect(normalizeBase("/galley")).toBe("/galley/");
    expect(normalizeBase("/galley/")).toBe("/galley/");
  });
});

describe("joinBase", () => {
  it("is the IDENTITY at the root base", () => {
    expect(joinBase("/", "/")).toBe("/");
    expect(joinBase("/", "/library")).toBe("/library");
    expect(joinBase("/", "/join/share-x?role=editor")).toBe("/join/share-x?role=editor");
  });

  it("prefixes an app-absolute path under a subpath base", () => {
    expect(joinBase("/galley/", "/")).toBe("/galley/");
    expect(joinBase("/galley/", "/library")).toBe("/galley/library");
    expect(joinBase("/galley/", "/p/abc")).toBe("/galley/p/abc");
    expect(joinBase("/galley/", "/join/share-x?role=editor")).toBe(
      "/galley/join/share-x?role=editor",
    );
  });

  it("leaves a non-absolute path alone — there is nothing to prefix", () => {
    expect(joinBase("/galley/", "library")).toBe("library");
    expect(joinBase("/galley/", "https://elsewhere.example/x")).toBe("https://elsewhere.example/x");
  });
});

describe("stripBaseFrom", () => {
  it("is the IDENTITY at the root base", () => {
    expect(stripBaseFrom("/", "/")).toBe("/");
    expect(stripBaseFrom("/", "/library")).toBe("/library");
  });

  it("removes a subpath base, including the bare base with no trailing slash", () => {
    expect(stripBaseFrom("/galley/", "/galley/")).toBe("/");
    expect(stripBaseFrom("/galley/", "/galley")).toBe("/");
    expect(stripBaseFrom("/galley/", "/galley/library")).toBe("/library");
    expect(stripBaseFrom("/galley/", "/galley/p/abc")).toBe("/p/abc");
  });

  it("round-trips joinBase for every route shape", () => {
    for (const path of ["/", "/library", "/settings", "/p/abc", "/join/share-x"]) {
      expect(stripBaseFrom("/galley/", joinBase("/galley/", path))).toBe(path);
    }
  });

  it("leaves an off-base pathname alone (defensive — should never happen)", () => {
    expect(stripBaseFrom("/galley/", "/elsewhere/x")).toBe("/elsewhere/x");
  });
});

describe("the live wrappers read Vite's BASE_URL", () => {
  it("default build → the root base, so callers see today's values", () => {
    expect(deployBase()).toBe("/");
    expect(withBase("/library")).toBe("/library");
    expect(stripBase("/library")).toBe("/library");
  });

  it("subpath build → the base is applied in both directions", () => {
    vi.stubEnv("BASE_URL", "/galley/");
    expect(deployBase()).toBe("/galley/");
    expect(withBase("/library")).toBe("/galley/library");
    expect(stripBase("/galley/library")).toBe("/library");
  });
});
