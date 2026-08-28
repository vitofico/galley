/**
 * The kernel's compile seam (#16.1, ADR-0020): `compile` POSTs the document to
 * an EXPLICITLY configured apps/compile service (`POST /compile`, op `check` —
 * the same HTTP contract the browser's RemoteCompilerClient speaks) and returns
 * its diagnostics. The service is injectable so tests use a fake; the real one
 * is built from `--compile-url`, which config.ts pins to a LOOPBACK host. With
 * no URL configured the tool reports a structured "not configured" result
 * (see server.ts); this module never guesses an endpoint.
 *
 * Transport discipline (Security-Analyst finding 2, mirroring the ADR-0019 git
 * transport's redirect/caps stance): the request body IS the document, so the
 * client NEVER follows a redirect (`redirect: "error"` — a 307/308 would
 * replay the POST body to a different host), aborts after a hard timeout, and
 * caps the response size before parsing (a misbehaving service cannot balloon
 * kernel memory).
 */
import type { CheckResult, CompileArtifact, CompileInput } from "@galley/shared";

export interface CompileService {
  check(input: CompileInput): Promise<CheckResult>;
}

/** Hard request deadline; generous over the service's own ~20s compile timeout. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Max response bytes accepted before parsing (diagnostics JSON is small). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The slice of `fetch` this client uses — injectable for tests. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    /** Always "error": the POST body must never be replayed via a redirect. */
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<ResponseLike>;

export interface ResponseLike {
  ok: boolean;
  status: number;
  /** Standard streaming body when available (used for the size-capped read). */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  text(): Promise<string>;
}

/**
 * Read the response body, refusing more than `maxBytes`. Prefers the stream
 * (an oversized body aborts mid-read without buffering it all); falls back to
 * `text()` + a byte check for minimal fakes/bodies without a reader.
 */
async function readCapped(res: ResponseLike, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > maxBytes) {
      throw new Error(`compile service response exceeds ${maxBytes} bytes`);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`compile service response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** Shape-check the service's response so a misbehaving endpoint fails honestly. */
function asCheckResult(body: unknown): CheckResult {
  const r = body as Partial<CheckResult> | null;
  if (
    typeof r !== "object" ||
    r === null ||
    typeof r.ok !== "boolean" ||
    !Array.isArray(r.diagnostics)
  ) {
    throw new Error("compile service returned an unexpected response shape");
  }
  // ADDITIVE (D3): pass through a well-formed artifact descriptor, drop a
  // malformed one. The bytes/hash are advisory — a service that predates the
  // field (or emits junk) simply yields no descriptor, never a parse failure.
  const artifact = asArtifact(r.artifact);
  return {
    ok: r.ok,
    diagnostics: r.diagnostics,
    pageCount: typeof r.pageCount === "number" ? r.pageCount : null,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    ...(artifact !== undefined ? { artifact } : {}),
  };
}

/** A 64-char lowercase-hex sha256 digest (the artifact's content address). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Validate the optional artifact descriptor; junk → undefined (dropped, never
 * a parse failure of the whole result). HARDENED: `bytes` must be a NON-NEGATIVE
 * INTEGER and `hash` a 64-char lowercase sha256 hex string — a misbehaving
 * service cannot smuggle a fractional/negative size or a non-canonical hash
 * through as if it were a real content address.
 */
function asArtifact(value: unknown): CompileArtifact | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const a = value as Partial<CompileArtifact>;
  if (typeof a.bytes !== "number" || !Number.isInteger(a.bytes) || a.bytes < 0) return undefined;
  if (typeof a.hash !== "string" || !SHA256_HEX.test(a.hash)) return undefined;
  return a.mime !== undefined && typeof a.mime === "string"
    ? { bytes: a.bytes, hash: a.hash, mime: a.mime }
    : { bytes: a.bytes, hash: a.hash };
}

export function createHttpCompileService(
  baseUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  opts: { timeoutMs?: number } = {},
): CompileService {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async check(input: CompileInput): Promise<CheckResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      let res: ResponseLike;
      try {
        res = await fetchImpl(`${baseUrl}/compile`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "check", input }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (err) {
        // An abort is OUR deadline firing — report it as such, honestly.
        if (controller.signal.aborted) {
          throw new Error(`compile service timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const raw = await readCapped(res, MAX_RESPONSE_BYTES);
      if (!res.ok) {
        // The service's error bodies are small JSON `{ error }` strings (never a
        // document echo); surface the status + reason, nothing else.
        let reason = "";
        try {
          const body = JSON.parse(raw) as { error?: string };
          if (typeof body.error === "string") reason = `: ${body.error}`;
        } catch {
          /* non-JSON error body — the status alone is the message */
        }
        throw new Error(`compile service responded ${res.status}${reason}`);
      }
      return asCheckResult(JSON.parse(raw));
    },
  };
}
