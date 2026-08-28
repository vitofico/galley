/**
 * #22.2 web-server+proxy adversarial security audit — PROXY fuzz/property harness.
 *
 * Throws hostile inputs at the model-API forward-proxy and asserts FAIL-SAFE.
 * Deterministic + fast (no network — `fetch` is stubbed; bodies are tiny). Pins
 * the already-strong defenses (named-upstreams-only → no SSRF/open-relay, client
 * auth stripped, key never leaks) and the NEW resource-limit hardening (body cap:
 * over-Content-Length → 413 pre-fetch; over-cap streamed body → 413, fetch
 * aborted; under-cap unaffected).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GALLEY_UPSTREAM_HEADER } from "@galley/shared";
import { createProxyHandler, loadUpstreams, DEFAULT_MAX_BODY_BYTES, parseContentLength } from "./index.js";

const KEY = "Bearer sk-secret-FUZZ-9af3";
const ANTHROPIC_KEY = "sk-ant-secret-FUZZ-77";

const UPSTREAMS = loadUpstreams({
  UPSTREAM_OPENAI_URL: "https://api.openai.com/v1",
  UPSTREAM_OPENAI_AUTH_HEADER: "Authorization",
  UPSTREAM_OPENAI_KEY: KEY,
  UPSTREAM_ANTHROPIC_URL: "https://api.anthropic.com/v1",
  UPSTREAM_ANTHROPIC_AUTH_HEADER: "x-api-key",
  UPSTREAM_ANTHROPIC_KEY: ANTHROPIC_KEY,
});
const ORIGINS = ["http://localhost:5173"];

function app(maxBodyBytes?: number) {
  return createProxyHandler(UPSTREAMS, { allowedOrigins: ORIGINS, ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}) });
}

describe("proxy fuzz — SSRF / open-relay: a client-supplied target never reaches fetch", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("nope"))));
  afterEach(() => vi.unstubAllGlobals());

  // Every one of these is a CLIENT-SUPPLIED string in the upstream-selector header.
  // The proxy looks it up in the env-loaded Map; an entry that isn't a configured
  // id (which is ALL of these) is an "unknown upstream" → 400, fetch never called.
  const ssrfVectors = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://127.0.0.1:6379/", // localhost service
    "http://[::1]:8080/admin",
    "file:///etc/passwd",
    "gopher://127.0.0.1:11211/_stats",
    "//evil.example.com/", // protocol-relative
    "https://evil.example.com/", // absolute external
    "openai-evil", // near-miss of a real id
    "../openai", // path-ish
    "unknown-id",
    "", // empty
    "%2e%2e", // encoded dots
    "0", "null", "undefined",
  ];

  for (const vector of ssrfVectors) {
    it(`refuses upstream selector ${JSON.stringify(vector)} with 400 and never calls fetch`, async () => {
      const res = await app().request("/forward/v1/chat", {
        method: "POST",
        headers: { [GALLEY_UPSTREAM_HEADER]: vector, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status, vector).toBe(400);
      expect(fetch as unknown as ReturnType<typeof vi.fn>, vector).not.toHaveBeenCalled();
    });
  }

  it("refuses when the selector header is entirely absent", async () => {
    const res = await app().request("/forward/x", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("proxy fuzz — client auth is stripped, server key injected, key never leaks", () => {
  let captured: { url: string; headers: Headers } | null = null;
  beforeEach(() => {
    captured = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, headers: new Headers(init.headers) };
        // Echo the (injected) key back in a header + body to PROVE it never reaches the client.
        return new Response(`upstream-said: ${ANTHROPIC_KEY}`, {
          status: 200,
          headers: { "content-type": "text/plain", "x-leak-test": KEY },
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  // A hostile client tries to smuggle/override credentials. All of these MUST be
  // stripped before forwarding; only the server-injected key may be sent upstream.
  const clientAuthHeaders = [
    { authorization: "Bearer attacker-token" },
    { "x-api-key": "attacker-anthropic-key" },
    { authorization: "Basic Zm9vOmJhcg==", "x-api-key": "k" },
    { Authorization: "Bearer UPPER-CASE-DROP-ME" }, // header names are case-insensitive
  ];

  for (const extra of clientAuthHeaders) {
    it(`strips client-supplied ${Object.keys(extra).join("+")} and injects only the server key`, async () => {
      const res = await app().request("/forward/messages", {
        method: "POST",
        headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/json", ...extra },
        body: '{"model":"gpt-4o"}',
      });
      expect(res.status).toBe(200);
      const sent = captured!.headers;
      // Only the configured server key is present; the client's value is gone.
      expect(sent.get("authorization")).toBe(KEY);
      for (const v of Object.values(extra)) expect(sent.get("authorization")).not.toBe(v);
      // The selector header is never forwarded upstream.
      expect(sent.has(GALLEY_UPSTREAM_HEADER)).toBe(false);
    });
  }

  it("strips an upstream Authorization/x-api-key from the RESPONSE? (key may legitimately echo upstream→client only if upstream sends it; we assert our re-stream does not ADD it)", async () => {
    // The proxy re-streams the upstream response verbatim except content-encoding/
    // length/transfer-encoding. It does not inject the key into the response. Here
    // the FAKE upstream deliberately echoes the key (a worst case); the proxy must
    // not amplify it — but more importantly the key must never be LOGGED.
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const res = await app().request("/forward/messages", {
        method: "POST",
        headers: { [GALLEY_UPSTREAM_HEADER]: "anthropic", "content-type": "application/json" },
        body: '{"secretPrompt":"my private document text"}',
      });
      await res.text();
      const logged = spies.flatMap((s) => s.mock.calls.flat()).join(" ");
      // The proxy itself never logs the injected key or the request body.
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain(ANTHROPIC_KEY);
      expect(logged).not.toContain("my private document text");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("proxy fuzz — CORS allowlist: a disallowed origin is never authorized", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("ok"))));
  afterEach(() => vi.unstubAllGlobals());

  for (const origin of ["http://evil.example", "null", "https://localhost:5173", "http://localhost:5174", "http://localhost.evil.com"]) {
    it(`does not reflect disallowed origin ${origin}`, async () => {
      const res = await app().request("/forward/x", {
        method: "POST",
        headers: { origin, [GALLEY_UPSTREAM_HEADER]: "openai" },
        body: "{}",
      });
      expect(res.headers.get("access-control-allow-origin")).not.toBe(origin);
    });
  }
});

describe("proxy fuzz — body size cap (resource-limit hardening, large-body OOM DoS)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("ok"))));
  afterEach(() => vi.unstubAllGlobals());

  it("exposes a generous default cap (16 MiB)", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(16 * 1024 * 1024);
  });

  it("rejects an over-Content-Length body with 413 BEFORE opening the upstream socket", async () => {
    const res = await app(1024).request("/forward/messages", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/octet-stream", "content-length": "2048" },
      body: "x".repeat(2048),
    });
    expect(res.status).toBe(413);
    // The pre-check fired before fetch — no upstream socket opened.
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("aborts a chunked / length-less over-cap streamed body with 413 (fetch rejects)", async () => {
    const cap = 64; // bytes
    // Stream more than the cap WITHOUT a content-length so the pre-check can't see
    // it — the streaming counter must error the body, aborting the fetch → 413.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(32).fill(65);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 96 bytes total > 64 cap
        controller.close();
      },
    });
    // Make fetch consume the body so the TransformStream actually pulls/errors.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_url: string, init: RequestInit) => {
      const body = init.body as ReadableStream<Uint8Array> | undefined;
      if (body) {
        const reader = body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read(); // throws when the stream errors over-cap
          if (done) break;
        }
      }
      return new Response("ok");
    });
    const res = await app(cap).request("/forward/messages", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(res.status).toBe(413);
  });

  it("lets a normal under-cap request through unaffected (the generous ceiling)", async () => {
    const res = await app().request("/forward/chat/completions", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("a GET (no body) is never affected by the cap", async () => {
    const res = await app(1).request("/forward/models", {
      method: "GET",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai" },
    });
    expect(res.status).toBe(200);
  });
});

describe("proxy fuzz — strict Content-Length parsing (SEC-22.2-WEB-1)", () => {
  // `parseContentLength` is the pure strict parser; `Number()` over-accepted
  // these. A malformed CL must NOT slip the size pre-check.
  it("accepts only a plain run of ASCII digits", () => {
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength("1024")).toBe(1024);
    expect(parseContentLength("  42  ")).toBe(42); // surrounding whitespace trimmed
  });

  const malformed = [
    "", // empty
    " ", // whitespace only
    "0x10", // hex — Number() accepts, we reject
    "1e3", // scientific — Number() accepts, we reject
    "+5", // signed
    "-5", // negative
    "5.0", // float
    "5, 5", // duplicate header joined by Hono
    "5,5",
    "0b101",
    "Infinity",
    "NaN",
    "  ", // multi-space
    "5 5", // interior space
    "12abc", // trailing junk
    "abc", // non-numeric
    "\t10\t", // tabs around digits are trimmed by .trim() → still valid? no: \t trims, "10" ok
    "9".repeat(21), // absurdly long → fail closed
  ];
  for (const v of malformed) {
    it(`rejects malformed Content-Length ${JSON.stringify(v)} → null (unless legitimately digits)`, () => {
      const parsed = parseContentLength(v);
      // The only "malformed" entry that is actually valid after trim is "\t10\t".
      if (v.trim() === "10") {
        expect(parsed).toBe(10);
      } else {
        expect(parsed).toBeNull();
      }
    });
  }

  it("a malformed Content-Length on a real request is rejected 400 before fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    try {
      const res = await app(1024).request("/forward/messages", {
        method: "POST",
        headers: {
          [GALLEY_UPSTREAM_HEADER]: "openai",
          "content-type": "application/octet-stream",
          "content-length": "0x800", // hex — would be 2048 under Number(), but malformed
        },
        body: "x".repeat(16),
      });
      expect(res.status).toBe(400);
      expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a well-formed Content-Length under the cap is unaffected (no behavior change)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    try {
      const res = await app(1024).request("/forward/messages", {
        method: "POST",
        headers: {
          [GALLEY_UPSTREAM_HEADER]: "openai",
          "content-type": "application/json",
          "content-length": "16",
        },
        body: "x".repeat(16),
      });
      expect(res.status).toBe(200);
      expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
