/**
 * #22.2 compile+registry audit — the in-code SSRF guard for the operator-configured
 * registry base URL. It unconditionally rejects destinations that are NEVER a
 * legitimate Typst registry: IPv4/IPv6 link-local addresses (notably the
 * 169.254.169.254 cloud-metadata IP) and IPv6 unique-local (ULA) addresses, plus
 * the well-known cloud-metadata hostnames.
 *
 * Scope of this layer (be honest about the boundary):
 *   - This is a STRING / IP-LITERAL check on the configured host. It catches the
 *     obvious operator-misconfig footgun (a metadata IP literal as the base URL).
 *   - It CANNOT catch a public-looking hostname that *resolves* to a link-local /
 *     internal address (DNS rebinding / split-horizon). That residual must be
 *     covered by infra-level egress controls (k8s NetworkPolicy / a no-metadata
 *     route), documented in docs/known-issues.md. The base URL is operator config
 *     (never user-controlled), so this is defense-in-depth, not the primary edge.
 *
 * Deliberately NOT blocked: RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 * and loopback (127.0.0.1 / localhost / [::1]) — a legitimate internal registry
 * mirror or the offline e2e loopback fixture lives there. Blocking those would
 * break real deployments; the metadata/link-local hole is the one that's never legit.
 */

/** Hostnames that always denote a cloud-metadata endpoint (never a real registry). */
const METADATA_HOSTNAMES = new Set(["metadata", "metadata.google.internal"]);

/**
 * Strip a single trailing root-label dot from a hostname. A fully-qualified
 * domain name may carry a trailing `.` (the DNS root label) — `URL.hostname`
 * preserves it, so `metadata.google.internal.` reaches the guard verbatim and
 * would MISS the exact `METADATA_HOSTNAMES` Set lookup. Normalize it away before
 * the metadata comparison (one dot only — `metadata..` is not a valid FQDN and
 * stays distinct). IPv6 literals never carry a trailing dot, so this is a no-op
 * for them.
 */
function stripRootDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** Strip the `[...]` brackets a URL keeps around an IPv6 literal, if present. */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True iff `host` is a dotted-quad IPv4 literal in 169.254.0.0/16 (link-local). */
function isIpv4LinkLocal(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map((n) => Number(n));
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 169 && octets[1] === 254;
}

/**
 * Expand an (unbracketed, lowercased) IPv6 literal to its eight numeric 16-bit
 * hextets, or `null` if it isn't a well-formed IPv6 literal. Handles `::`
 * zero-compression and a trailing embedded IPv4 dotted-quad (`::ffff:a.b.c.d`),
 * which becomes the final two hextets `(a<<8|b, c<<8|d)`.
 *
 * Numeric expansion is the point: membership decisions then compare the FIRST
 * hextet's VALUE (not a substring), so `fe8` (= 0x0fe8) is correctly NOT in
 * fe80–febf, and `a9fe` only matters as the low-32-bit embedded-IPv4 tail — never
 * as an arbitrary substring of a public address like `2606:4700:a9fe::1`.
 */
function expandHextets(inner: string): number[] | null {
  // Split off a trailing embedded IPv4 (`…:a.b.c.d`) and convert it to 2 hextets.
  let body = inner;
  const tail: number[] = [];
  const v4 = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(inner);
  if (v4) {
    const q = v4.slice(1, 5).map(Number);
    if (q.some((n) => n > 255)) return null;
    tail.push((q[0]! << 8) | q[1]!, (q[2]! << 8) | q[3]!);
    body = inner.slice(0, v4.index + 1); // keep the colon before the quad
  }

  const halves = body.split("::");
  if (halves.length > 2) return null; // more than one `::` is invalid

  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const parts = s.split(":");
    const out: number[] = [];
    for (const p of parts) {
      if (p === "" || !/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    // Compressed form `head::tail` — fill the gap with zero hextets. Trim a stray
    // boundary colon left by splitting off an embedded-IPv4 tail (e.g. body
    // `::ffff:` from `::ffff:169.254.169.254` leaves `ffff:`).
    const head = toGroups(halves[0]!.replace(/:$/, ""));
    const rest = toGroups(halves[1]!.replace(/^:|:$/g, ""));
    if (head === null || rest === null) return null;
    const known = head.length + rest.length + tail.length;
    if (known > 8) return null;
    const zeros = new Array(8 - known).fill(0) as number[];
    return [...head, ...zeros, ...rest, ...tail];
  }

  // Uncompressed — must be exactly 8 hextets total (including any v4 tail).
  const groups = toGroups(body.replace(/:$/, ""));
  if (groups === null) return null;
  const all = [...groups, ...tail];
  return all.length === 8 ? all : null;
}

/**
 * True iff `inner` (an unbracketed IPv6 literal) is link-local (fe80::/10) or
 * unique-local (fc00::/7), or carries the 169.254.169.254 cloud-metadata IP as
 * its embedded IPv4-mapped/compat low-32-bits (`::ffff:a9fe:a9fe` /
 * `::a9fe:a9fe` / `::ffff:169.254.169.254`).
 *
 * Decisions are NUMERIC over the expanded hextets, so a public address that
 * merely contains `a9fe` (e.g. `2606:4700:a9fe::1`) is NOT blocked, and a
 * shortened hextet like `fe8` (0x0fe8) is correctly outside fe80–febf.
 */
function isIpv6Internal(inner: string): boolean {
  const groups = expandHextets(inner.toLowerCase());
  if (groups === null) return false; // unparseable → not our concern (won't connect)

  const first = groups[0]!;
  // fe80::/10 — the top 10 bits are 1111 1110 10, i.e. first hextet 0xfe80..0xfebf.
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  // fc00::/7 — unique-local; top 7 bits 1111 110, i.e. first hextet 0xfc00..0xfdff.
  if (first >= 0xfc00 && first <= 0xfdff) return true;

  // Embedded 169.254.169.254 as the low 32 bits of an IPv4-mapped/compat address:
  // the last two hextets are 0xa9fe, 0xa9fe AND every higher hextet is zero except
  // an optional `::ffff` mapping marker (hextet 6 may be 0x0000 or 0xffff).
  const [h7, h8] = [groups[6]!, groups[7]!];
  if (h7 === 0xa9fe && h8 === 0xa9fe) {
    const prefixZeroExceptMappedMarker = groups
      .slice(0, 6)
      .every((g, i) => g === 0 || (i === 5 && g === 0xffff));
    if (prefixZeroExceptMappedMarker) return true;
  }
  return false;
}

/**
 * Decide whether a registry host must be refused as an SSRF target. Pure (no DNS,
 * no I/O) so it is exhaustively unit-testable. `hostname` is a URL's `hostname`
 * (IPv6 literals arrive bracketed, e.g. `[fe80::1]`, already lowercased by URL).
 */
export function isBlockedRegistryHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // Metadata-hostname check: normalize away a trailing root-label dot first, so
  // `metadata.google.internal.` / `metadata.` can't slip past the exact lookup.
  if (METADATA_HOSTNAMES.has(stripRootDot(host))) return true;
  if (isIpv4LinkLocal(host)) return true;
  const inner = unbracket(host);
  if (inner !== host || inner.includes(":")) {
    // Bracketed or otherwise a colon-bearing IPv6 literal.
    if (isIpv6Internal(inner)) return true;
  }
  return false;
}
