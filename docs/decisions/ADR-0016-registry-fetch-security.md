# ADR-0016 — Server-side package fetch + archive extraction (security)

- **Status:** Accepted; built core-first (slice 5a = archive core; 5b = fetch).
- **Relates to:** ADR-0014 (resolver seam + validation), ADR-0015 (server-side
  compile). Implements the deferred, sandboxed Universe fetch behind the ADR-0014
  seam.
- **Review:** threat-modeled by the Security-Analyst (GPT) before implementation;
  its verdict + must-fixes are baked in below.

## Context

ADR-0015 wires typst.ts's package callback to a `PackageResolver` (slice 1). The
remaining piece is the resolver that actually obtains a Universe package: fetch a
`tar.gz` over HTTPS, decompress, extract, and hand the files to ADR-0014's
`resolvePackagePaths`. This is the one place Galley ingests untrusted bytes from
the network, so it was threat-modeled before any code.

## Decision

**Strict, in-memory, fail-closed, fixed-host, integrity-verified.** Split into a
pure archive core (slice 5a, this commit) and the network fetch/prewarm (5b).

### Archive core (slice 5a — `apps/compile/src/package-archive.ts`)

- **`gunzipWithCap(gz, max)`** — async zlib with `maxOutputLength`, so a tiny
  body can't expand without bound (zip-bomb guard); async so it never blocks the
  request event loop. Caps compressed size separately (in 5b, before this).
- **`untarStrict(bytes, limits)`** — a deliberately **intolerant** ustar reader:
  verifies the header **checksum** before trusting any field; accepts only
  **regular files** ('0'/NUL) and skips directories; **rejects** symlink/hardlink/
  device/fifo, **GNU and PAX** extensions, and **base-256** numeric fields;
  requires the claimed data **plus padding** to exist (no truncation) and **zero**
  trailing bytes after the end marker; never allocates on a header's word; decodes
  content as **strict UTF-8** (invalid → error). Enforces file-count/per-file/total
  byte caps. Extraction is **in-memory only** — never touches disk.
- **`verifyIntegrity(bytes, {sha256,size})`** — constant-time SHA-256 + size check;
  throws on any mismatch. The production fetch path **requires** an expected hash
  (see below).
- Output is raw `{path,text}` files that still flow through ADR-0014
  `resolvePackagePaths` (the single re-root/validation gate) — defense in depth.

### Network fetch (slice 5b — to come)

Bakes in the Security-Analyst must-fixes: URL built **only** from a validated
`PackageSpec` + a **fixed configured host** (allow-list namespace `preview`;
reject IP literals / private ranges / userinfo / query / hash / non-`https`);
`fetch` with `redirect:"manual"` (reject 3xx); compressed-size cap read
incrementally (Content-Length untrusted); `AbortController` timeout; **required**
`{sha256,size}` from an operator-supplied manifest, **fail closed when absent**
(unverified fetch only behind an explicit dev/unsafe flag); per-request package
count + total-bytes + concurrency caps; in-memory LRU cache keyed by spec (+ policy);
**generic** failure responses and logs limited to canonical package ID + reason +
byte counts (never source/response bodies, URLs-with-creds, or secrets). Re-validate
the spec at the resolver boundary (typst may pass one that didn't come from the
pre-scan).

## Security review outcome

Risk rating: **HIGH** before integrity + strict-tar tests; **MEDIUM** once required
hashes, the strict parser, caps, egress controls, and the fail-closed tests are in
place (slice 5a + 5b). No critical vulns in the design given fixed-host /
no-redirect / capped / fail-closed.

**Verdict on hand-rolled tar:** acceptable (not extracting to disk; reject all
non-regular entries before the ADR-0014 gate) **provided it is strict** — which
5a's checksum/typeflag/size/padding/UTF-8 guards enforce. A vetted *parser*
(`tar-stream`) would be the alternative; a filesystem *extractor* is forbidden.

**Verdict on integrity:** "TLS + opt-in" is **not** sufficient. Production package
resolution **requires** an expected SHA-256 + size (operator-supplied
lock/manifest, usable against the offline fixture too) and **fails closed** when a
hash is absent; unverified network fetch is dev/unsafe-flagged only.

## Consequences

- The browser path is unaffected and remains fail-closed; server-side fetch is
  opt-in, integrity-gated, and off by default.
- 5a is fully offline-unit-tested (in-memory tar/gzip bytes + the full rejection
  matrix); 5b is tested against a local HTTP fixture, never live Universe.
