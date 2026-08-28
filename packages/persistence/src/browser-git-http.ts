/**
 * Lane S — the BROWSER transport for the E6 git-remote projection (#4 / ADR-0018,
 * hardened per ADR-0019 security review).
 *
 * `HttpRemoteSync` (in `git-remote-core.ts`) takes an injected {@link GitHttpClient}
 * so the projection logic never imports an `isomorphic-git/http/*` subpath at
 * module load — keeping that file network-free and the CI gate offline. This
 * module supplies the ONE concrete browser client, a `fetch`-based smart-HTTP
 * transport equivalent to `isomorphic-git/http/web` but with two added security
 * controls the stock client lacks:
 *
 *  - **No redirects (REC-5).** The stock `http/web` calls `fetch(url, …)` with the
 *    default `redirect: "follow"`, so a remote could 30x a request to another
 *    origin or downgrade `https`→`http` — carrying the `Authorization` header (or
 *    not, but either way leaking request shape / enabling SSRF-style hops). We set
 *    `redirect: "error"`, so any redirect rejects the request. There is no
 *    legitimate redirect in the smart-HTTP info/refs + upload/receive-pack flow we
 *    drive.
 *  - **Inbound byte cap (HIGH-3).** `DEFAULT_FETCH_LIMITS` only bounded the
 *    candidate AFTER `git.fetch` had already streamed the whole pack into the
 *    in-memory fs. Here we reject oversized responses BEFORE objects land: a
 *    `Content-Length` over the cap aborts immediately, and (for chunked responses
 *    with no/again lying length) the body stream is aborted the moment cumulative
 *    bytes exceed the cap. The cap is {@link MAX_INBOUND_RESPONSE_BYTES}.
 *
 * Why it lives HERE and not in `apps/web`: `isomorphic-git` is already a
 * dependency of `@galley/persistence`, not of `apps/web`. A single owner of the
 * git transport keeps the import graph clean and the controls in one place.
 *
 * Auth still flows ONLY through `HttpRemoteSync.onAuth` (HTTP Basic), never inside
 * this client or a URL it builds.
 */
import { DEFAULT_FETCH_LIMITS, type GitHttpClient } from "./git-remote-core.js";

/**
 * Hard cap on the bytes a single git smart-HTTP response may stream into the
 * in-memory fs (HIGH-3 DoS guard). A fetched git PACK is compressed and carries
 * history, so it can legitimately exceed the materialized `maxTotalBytes`; we
 * allow a generous multiple, but still bound it so a hostile/compromised remote
 * cannot force an unbounded browser download before the candidate caps apply.
 */
export const MAX_INBOUND_RESPONSE_BYTES = DEFAULT_FETCH_LIMITS.maxTotalBytes * 4; // 200 MiB

/** Thrown when a response exceeds {@link MAX_INBOUND_RESPONSE_BYTES} (secret-free). */
export class InboundCapError extends Error {
  constructor() {
    super("remote response exceeds the inbound size cap");
    this.name = "InboundCapError";
  }
}

/** isomorphic-git's `GitHttpRequest`/`GitHttpResponse` (the slice we use). */
interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  onProgress?: unknown;
}

/** Collect an (async)iterable of chunks into one `Uint8Array` (for the request body). */
async function collect(iterable: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
  const buffers: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of iterable as AsyncIterable<Uint8Array>) {
    buffers.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const b of buffers) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out;
}

/**
 * Wrap a response `ReadableStream` so cumulative bytes are counted and the stream
 * is ABORTED (cancelled + the iterator throws) the instant the running total
 * exceeds `cap`. This is what stops a chunked / length-lying pack before the
 * objects reach the fs.
 */
function cappedIterator(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  return {
    async next() {
      const { done, value } = await reader.read();
      if (done) return { done: true, value: undefined };
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new InboundCapError();
      }
      return { done: false, value };
    },
    async return() {
      reader.releaseLock();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * The hardened browser smart-HTTP `request`. Mirrors `isomorphic-git/http/web`'s
 * contract (returns `{ statusCode, statusMessage, body, headers, url, method }`)
 * but adds the no-redirect policy and the inbound byte cap described above.
 */
async function hardenedRequest(req: GitHttpRequest): Promise<unknown> {
  const { url, method = "GET", headers = {}, body } = req;
  // Streaming uploads aren't supported in browsers; buffer like the stock client.
  const collected = body ? await collect(body) : undefined;
  const init = {
    method,
    headers,
    // REC-5: refuse ANY redirect (no cross-origin hop, no https→http downgrade).
    redirect: "error" as const,
    ...(collected ? { body: collected } : {}),
  } as unknown as RequestInit;
  const res = await fetch(url, init);

  // HIGH-3 (fast path): a declared length over the cap aborts before reading.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INBOUND_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new InboundCapError();
  }

  // HIGH-3 (stream path): count + abort as bytes arrive (handles chunked / lying length).
  let iter: AsyncIterableIterator<Uint8Array> | Uint8Array[];
  if (res.body && typeof res.body.getReader === "function") {
    iter = cappedIterator(res.body, MAX_INBOUND_RESPONSE_BYTES);
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_INBOUND_RESPONSE_BYTES) throw new InboundCapError();
    iter = [buf];
  }

  const outHeaders: Record<string, string> = {};
  for (const [k, v] of res.headers.entries()) outHeaders[k] = v;
  return {
    url: res.url,
    method,
    statusCode: res.status,
    statusMessage: res.statusText,
    body: iter,
    headers: outHeaders,
  };
}

/**
 * Build the hardened browser `GitHttpClient` for {@link HttpRemoteSync}: a stock
 * `fetch`-backed smart-HTTP transport with a no-redirect policy (REC-5) and an
 * inbound byte cap (HIGH-3). Auth never rides inside the client — only via
 * `HttpRemoteSync.onAuth`.
 */
export function createBrowserGitHttp(): GitHttpClient {
  return { request: (args: unknown) => hardenedRequest(args as GitHttpRequest) };
}
