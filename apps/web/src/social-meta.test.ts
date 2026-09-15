import { describe, it, expect } from "vitest";
import {
  buildSocialMetaTags,
  normalizePublicUrl,
  SOCIAL_TITLE,
} from "./social-meta.js";

const DEMO = "https://vitofico.github.io/galley/";

describe("normalizePublicUrl", () => {
  it("strips a trailing slash and keeps the subpath", () => {
    expect(normalizePublicUrl(DEMO)).toBe("https://vitofico.github.io/galley");
  });

  it("accepts a bare origin", () => {
    expect(normalizePublicUrl("https://galley.example")).toBe("https://galley.example");
  });

  it("accepts http for a LAN self-host", () => {
    expect(normalizePublicUrl("http://galley.lan:8080")).toBe("http://galley.lan:8080");
  });

  it("is null for unset, blank, or whitespace (the identity case)", () => {
    expect(normalizePublicUrl(undefined)).toBeNull();
    expect(normalizePublicUrl(null)).toBeNull();
    expect(normalizePublicUrl("")).toBeNull();
    expect(normalizePublicUrl("   ")).toBeNull();
  });

  it("fails CLOSED on anything not an absolute http(s) URL", () => {
    // Better no preview at all than a preview pointing somewhere wrong.
    expect(normalizePublicUrl("/galley/")).toBeNull();
    expect(normalizePublicUrl("vitofico.github.io")).toBeNull();
    expect(normalizePublicUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePublicUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("buildSocialMetaTags", () => {
  it("emits NOTHING when no public URL is configured", () => {
    // The identity: a self-hosted build's HTML is byte-identical to before.
    expect(buildSocialMetaTags(undefined)).toBe("");
    expect(buildSocialMetaTags("")).toBe("");
    expect(buildSocialMetaTags("not-a-url")).toBe("");
  });

  it("points og:url and og:image at the configured origin, absolutely", () => {
    const tags = buildSocialMetaTags(DEMO);
    expect(tags).toContain('content="https://vitofico.github.io/galley/"');
    expect(tags).toContain('content="https://vitofico.github.io/galley/og-image.png"');
    // Relative URLs are not reliably resolved by crawlers — never emit one.
    expect(tags).not.toMatch(/content="\/[^/]/);
  });

  it("carries the large-image Twitter card and both image dimensions", () => {
    const tags = buildSocialMetaTags(DEMO);
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
    expect(tags).toContain('content="1280"');
    expect(tags).toContain('content="720"');
  });

  it("escapes interpolated copy rather than trusting it", () => {
    const tags = buildSocialMetaTags("https://example.com");
    expect(tags).not.toMatch(/content="[^"]*"[^/>]*"/);
    expect(tags).toContain(SOCIAL_TITLE.replace(/&/g, "&amp;"));
  });

  it("uses a different origin faithfully (a self-host that opts in)", () => {
    const tags = buildSocialMetaTags("https://galley.example/");
    expect(tags).toContain('content="https://galley.example/og-image.png"');
    expect(tags).not.toContain("vitofico");
  });
});
