/**
 * #22.2 compile+registry audit — exhaustive unit tests for `isBlockedRegistryHost`,
 * the in-code SSRF layer that unconditionally rejects link-local + cloud-metadata
 * destinations for the operator-configured registry base URL.
 *
 * Invariants pinned here:
 *   - 169.254.0.0/16 (incl. the 169.254.169.254 cloud-metadata IP) is BLOCKED.
 *   - IPv6 link-local fe80::/10 and ULA fc00::/7 are BLOCKED.
 *   - Known cloud-metadata hostnames are BLOCKED (string layer; DNS-rebind residual
 *     is covered by infra egress, not here).
 *   - Loopback (127.0.0.1 / localhost / [::1]) stays ALLOWED (the e2e fixture base).
 *   - Real public registries (packages.typst.org, a public IP) stay ALLOWED.
 *   - RFC1918 private ranges stay ALLOWED (legit internal-mirror deployments).
 */
import { describe, it, expect } from "vitest";
import { isBlockedRegistryHost } from "./registry-host-guard.js";

describe("isBlockedRegistryHost — link-local / metadata block", () => {
  it("blocks the cloud-metadata IP 169.254.169.254", () => {
    expect(isBlockedRegistryHost("169.254.169.254")).toBe(true);
  });

  it("blocks the whole 169.254.0.0/16 link-local range", () => {
    for (const h of ["169.254.0.0", "169.254.0.1", "169.254.1.1", "169.254.255.255", "169.254.169.254"]) {
      expect(isBlockedRegistryHost(h)).toBe(true);
    }
  });

  it("does NOT block neighbours just outside 169.254/16", () => {
    for (const h of ["169.253.255.255", "169.255.0.0", "170.254.169.254", "168.254.169.254"]) {
      expect(isBlockedRegistryHost(h)).toBe(false);
    }
  });

  it("blocks IPv6 link-local fe80::/10 (bracketed and bare)", () => {
    for (const h of ["[fe80::1]", "fe80::1", "[FE80::1]", "[fe80::169.254.169.254]", "[feb0::1]", "[febf::abcd]"]) {
      expect(isBlockedRegistryHost(h)).toBe(true);
    }
  });

  it("blocks IPv6 unique-local fc00::/7 (fc.. and fd..)", () => {
    for (const h of ["[fc00::1]", "[fd00::1]", "[fdab:cdef::1]", "fc00::1"]) {
      expect(isBlockedRegistryHost(h)).toBe(true);
    }
  });

  it("blocks the IPv4-mapped metadata address ::ffff:169.254.169.254", () => {
    for (const h of ["[::ffff:169.254.169.254]", "[::ffff:a9fe:a9fe]"]) {
      expect(isBlockedRegistryHost(h)).toBe(true);
    }
  });

  it("blocks known cloud-metadata hostnames (string layer)", () => {
    for (const h of [
      "metadata.google.internal",
      "metadata",
      "METADATA.GOOGLE.INTERNAL",
    ]) {
      expect(isBlockedRegistryHost(h)).toBe(true);
    }
  });

  it("blocks the trailing-root-dot FQDN form of a metadata host (#22.2 LOW fix)", () => {
    // URL.hostname preserves a trailing root-label dot; without normalization
    // these would miss the exact Set lookup and be wrongly ALLOWED.
    for (const h of [
      "metadata.google.internal.",
      "metadata.",
      "METADATA.GOOGLE.INTERNAL.",
    ]) {
      expect(isBlockedRegistryHost(h)).toBe(true);
    }
  });
});

describe("isBlockedRegistryHost — allowed destinations", () => {
  it("allows the public Typst registry host", () => {
    expect(isBlockedRegistryHost("packages.typst.org")).toBe(false);
  });

  it("allows a normal public IPv4 address", () => {
    for (const h of ["140.82.112.3", "8.8.8.8", "1.1.1.1"]) {
      expect(isBlockedRegistryHost(h)).toBe(false);
    }
  });

  it("allows a normal public IPv6 address", () => {
    expect(isBlockedRegistryHost("[2606:4700::1111]")).toBe(false);
  });

  it("allows a public IPv6 that merely CONTAINS a9fe / fe8x substrings (#22.2 LOW fix)", () => {
    // Numeric-hextet membership must not false-positive on a substring match:
    //   - 2606:4700:a9fe::1 is a legit public address (a9fe is NOT the embedded
    //     IPv4 low-32-bits, just a middle hextet);
    //   - fe8::1 → first hextet 0x0fe8, which is NOT in fe80–febf (link-local);
    //   - 2606:fc00::1 → fc00 as a non-leading hextet is not ULA membership.
    for (const h of ["[2606:4700:a9fe::1]", "[fe8::1]", "[2606:fc00::1]", "[a9fe::1]"]) {
      expect(isBlockedRegistryHost(h)).toBe(false);
    }
  });

  it("still blocks link-local/ULA/embedded-metadata under the numeric parse (#22.2 LOW fix)", () => {
    // Regression pins for the rewritten numeric logic — the genuinely-internal
    // forms must stay blocked.
    for (const h of [
      "[fe80::1]",
      "[febf::1]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[::ffff:a9fe:a9fe]",
      "[::a9fe:a9fe]",
      "[::ffff:169.254.169.254]",
    ]) {
      expect(isBlockedRegistryHost(h)).toBe(true);
    }
  });

  it("keeps loopback allowed (the e2e registry fixture)", () => {
    for (const h of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(isBlockedRegistryHost(h)).toBe(false);
    }
  });

  it("leaves RFC1918 private ranges allowed (legit internal mirror)", () => {
    for (const h of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(isBlockedRegistryHost(h)).toBe(false);
    }
  });
});
