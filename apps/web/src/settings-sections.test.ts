import { describe, it, expect } from "vitest";
import {
  SETTINGS_SECTIONS,
  isSettingsSection,
  sectionFromHash,
  settingsHref,
  settingsReturnHref,
} from "./settings-sections.js";

describe("SETTINGS_SECTIONS", () => {
  it("lists the settings sections (incl. Connect GitHub), ids unique, each with a label", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    // Ordered most-reached-first (collab/agent identity leads; credential +
    // capability-granting sections last). Order is presentation-only — consumers
    // key off `id`, never index — but it's pinned here so a reorder is deliberate.
    expect(ids).toEqual([
      "identity",
      "ai",
      "appearance",
      "editor",
      "compile",
      "github",
      "agent-access",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SETTINGS_SECTIONS) expect(s.label.length).toBeGreaterThan(0);
  });
});

describe("sectionFromHash", () => {
  it("parses a #-prefixed hash into its section id", () => {
    expect(sectionFromHash("#compile")).toBe("compile");
    expect(sectionFromHash("#ai")).toBe("ai");
  });

  it("accepts a bare id (no leading #)", () => {
    expect(sectionFromHash("editor")).toBe("editor");
  });

  it("returns null for empty/unknown hashes", () => {
    expect(sectionFromHash("")).toBeNull();
    expect(sectionFromHash("#")).toBeNull();
    expect(sectionFromHash("#nope")).toBeNull();
    expect(sectionFromHash("#Compile")).toBeNull(); // ids are exact, lower-case
  });
});

describe("settingsHref", () => {
  it("builds the plain page href and the per-section deep links", () => {
    expect(settingsHref()).toBe("/settings");
    expect(settingsHref("compile")).toBe("/settings#compile");
  });

  it("round-trips every section through sectionFromHash", () => {
    for (const { id } of SETTINGS_SECTIONS) {
      const hash = new URL(settingsHref(id), "http://x").hash;
      expect(sectionFromHash(hash)).toBe(id);
    }
  });

  it("threads an origin route as `?from=` (before any section hash) — H6", () => {
    // No `from` ⇒ the URL is byte-for-byte the old shape (back-compat pin).
    expect(settingsHref(undefined, "/p/abc")).toBe("/settings?from=%2Fp%2Fabc");
    expect(settingsHref("compile", "/p/abc")).toBe("/settings?from=%2Fp%2Fabc#compile");
    // A home origin is the default — no need to carry it.
    expect(settingsHref("compile", undefined)).toBe("/settings#compile");
  });
});

describe("settingsReturnHref", () => {
  it("returns the threaded origin route when it names a safe internal route — H6", () => {
    expect(settingsReturnHref("?from=%2Fp%2Fabc")).toBe("/p/abc");
    expect(settingsReturnHref("?from=%2Flibrary")).toBe("/library");
  });

  it("defaults to `/` when no origin was threaded", () => {
    expect(settingsReturnHref("")).toBe("/");
    expect(settingsReturnHref("?other=1")).toBe("/");
  });

  it("canonicalizes through the router — unknown paths fall back to home", () => {
    // `/p` with no id is not a project route ⇒ home.
    expect(settingsReturnHref("?from=%2Fp")).toBe("/");
    // The home route round-trips to `/`.
    expect(settingsReturnHref("?from=%2F")).toBe("/");
  });

  it("rejects external / protocol-relative origins (open-redirect guard)", () => {
    expect(settingsReturnHref("?from=https%3A%2F%2Fevil.com")).toBe("/");
    expect(settingsReturnHref("?from=%2F%2Fevil.com")).toBe("/");
    expect(settingsReturnHref("?from=javascript%3Aalert(1)")).toBe("/");
  });
});

describe("isSettingsSection", () => {
  it("guards non-strings and unknown ids", () => {
    expect(isSettingsSection("identity")).toBe(true);
    expect(isSettingsSection(42)).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
  });
});
