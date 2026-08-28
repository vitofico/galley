import type { Page } from "@playwright/test";

/**
 * A deterministic, OFFLINE fake git smart-HTTP remote, implemented as Playwright
 * route interception (#17.2 / ADR-0019 runtime probe). It speaks just enough of
 * the v1 smart-HTTP protocol for isomorphic-git@1.38.4 (the pinned version) to
 * complete a push against an EMPTY repository:
 *
 *  - `GET …/info/refs?service=git-upload-pack` → empty-repo v1 advertisement.
 *    (`HttpRemoteSync.pushTree` pre-fetches the remote tip to parent onto it; an
 *    empty advert makes isomorphic-git's `_fetch` return cleanly with zero refs,
 *    so the push proceeds as a root commit — no upload-pack POST ever happens.)
 *  - `GET …/info/refs?service=git-receive-pack` → empty-repo v1 advertisement
 *    carrying `report-status side-band-64k`. side-band-64k MUST be advertised:
 *    isomorphic-git's `_push` ALWAYS routes the response through
 *    `GitSideBand.demux` and `parseReceivePackResponse` reads ONLY the band-1
 *    FIFO — a plain (non-side-band) report would land in the unused
 *    `packetlines` stream and the parse would fail (verified against the
 *    1.38.4 source: src/commands/push.js + src/wire/parseReceivePackResponse.js).
 *  - `POST …/git-receive-pack` → captures the pack body, replies with a
 *    band-1-wrapped `unpack ok` + `ok <ref>` report-status.
 *  - `OPTIONS` (CORS preflight for the POST's non-simple content-type) → 204.
 *
 * FAIL-CLOSED: every request to the fake origin is intercepted and recorded;
 * anything outside the modelled endpoints is pushed to `unexpected` and answered
 * 500 — nothing ever egresses to the network (the host also doesn't resolve).
 * All responses carry permissive CORS headers because Chromium still enforces
 * CORS on route-fulfilled cross-origin responses.
 */

/** The fake remote origin — never resolved; ALL requests to it are intercepted. */
export const FAKE_GIT_ORIGIN = "https://git.example.test";

/** The repo URL the test types into the Git-sync panel. */
export const FAKE_GIT_REPO_URL = `${FAKE_GIT_ORIGIN}/galley/probe.git`;

const REPO_PATH = "/galley/probe.git";
const ZERO_OID = "0000000000000000000000000000000000000000";

const te = new TextEncoder();

/** Concatenate byte chunks (no Node `Buffer` in the protocol builders). */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Encode one pkt-line: 4-hex length prefix (incl. itself) + payload. */
export function pktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? te.encode(payload) : payload;
  const len = (bytes.byteLength + 4).toString(16).padStart(4, "0");
  return concatBytes(te.encode(len), bytes);
}

/** The pkt-line flush packet (`0000`). */
export const FLUSH_PKT = te.encode("0000");

/**
 * A v1 smart-HTTP ref advertisement for an EMPTY repo: the `# service=…` line, a
 * flush, the zero-id `capabilities^{}` line (the no-refs convention) carrying the
 * capability list after a NUL, and a closing flush.
 */
export function emptyRepoAdvertisement(service: string, capabilities: string): Uint8Array {
  return concatBytes(
    pktLine(`# service=${service}\n`),
    FLUSH_PKT,
    pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`),
    FLUSH_PKT,
  );
}

/**
 * A successful receive-pack report-status, band-1-wrapped (we advertise
 * side-band-64k, and isomorphic-git's response demux requires it — see module
 * docs): outer pkt-line whose payload is `\x01` + the INNER pkt-encoded report
 * (`unpack ok`, `ok <ref>`, flush), then an outer flush.
 */
export function receivePackSuccess(fullRef: string): Uint8Array {
  const innerReport = concatBytes(
    pktLine("unpack ok\n"),
    pktLine(`ok ${fullRef}\n`),
    FLUSH_PKT,
  );
  return concatBytes(pktLine(concatBytes(new Uint8Array([1]), innerReport)), FLUSH_PKT);
}

/** One intercepted request to the fake remote (in arrival order). */
export interface CapturedGitRequest {
  method: string;
  url: string;
  /** Provisional request headers (enough to scan for a leaked secret). */
  headers: Record<string, string>;
  /** Raw POST body bytes, when present. */
  body: Uint8Array | null;
}

export interface GitSmartHttpFixture {
  /** Every request that reached the fake origin, in order (incl. preflights). */
  requests: CapturedGitRequest[];
  /** Requests outside the modelled smart-HTTP endpoints (answered 500). */
  unexpected: CapturedGitRequest[];
  /** Bodies of `POST …/git-receive-pack` requests (the pushed packs). */
  receivePackBodies: Uint8Array[];
  /** `METHOD path?query` lines for readable assertions/diagnostics. */
  shortLines(): string[];
}

/**
 * Install the fake remote on `page`. Must be called BEFORE the navigation that
 * triggers git traffic. Returns the live capture object.
 */
export async function installGitSmartHttpFixture(
  page: Page,
  opts: { branch?: string } = {},
): Promise<GitSmartHttpFixture> {
  const fullRef = `refs/heads/${opts.branch ?? "main"}`;

  const fixture: GitSmartHttpFixture = {
    requests: [],
    unexpected: [],
    receivePackBodies: [],
    shortLines() {
      return this.requests.map((r) => {
        const u = new URL(r.url);
        return `${r.method} ${u.pathname}${u.search}`;
      });
    },
  };

  // Chromium enforces CORS even on route-fulfilled cross-origin responses, so
  // every reply (and the OPTIONS preflight) must carry permissive CORS headers.
  const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, git-protocol",
  };

  await page.route(`${FAKE_GIT_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const postBuf = method === "POST" ? req.postDataBuffer() : null;
    const captured: CapturedGitRequest = {
      method,
      url: req.url(),
      headers: req.headers(),
      body: postBuf ? new Uint8Array(postBuf) : null,
    };
    fixture.requests.push(captured);

    // CORS preflight (the POST's content-type is non-simple) — not git protocol.
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: CORS_HEADERS });
    }

    // Ref discovery for either service.
    if (method === "GET" && url.pathname === `${REPO_PATH}/info/refs`) {
      const service = url.searchParams.get("service");
      if (service === "git-upload-pack" || service === "git-receive-pack") {
        const caps =
          service === "git-receive-pack"
            ? // side-band-64k is REQUIRED by isomorphic-git's push demux (module docs).
              "report-status side-band-64k agent=git/galley-fixture"
            : "multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=git/galley-fixture";
        return route.fulfill({
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "content-type": `application/x-${service}-advertisement`,
            "cache-control": "no-cache",
          },
          body: Buffer.from(emptyRepoAdvertisement(service, caps)),
        });
      }
    }

    // The push itself: capture the pack, report success.
    if (method === "POST" && url.pathname === `${REPO_PATH}/git-receive-pack`) {
      if (captured.body) fixture.receivePackBodies.push(captured.body);
      return route.fulfill({
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
        },
        body: Buffer.from(receivePackSuccess(fullRef)),
      });
    }

    // FAIL-CLOSED: unmodelled traffic to the fake host is recorded and refused.
    fixture.unexpected.push(captured);
    return route.fulfill({ status: 500, headers: CORS_HEADERS, body: "unmodelled request" });
  });

  return fixture;
}
