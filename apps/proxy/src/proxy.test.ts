import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GALLEY_UPSTREAM_HEADER } from "@galley/shared";
import { createProxyHandler, loadUpstreams } from "./index.js";

const UPSTREAMS = loadUpstreams({
  UPSTREAM_OPENAI_URL: "https://api.openai.com/v1",
  UPSTREAM_OPENAI_AUTH_HEADER: "Authorization",
  UPSTREAM_OPENAI_KEY: "Bearer sk-secret-123",
  UPSTREAM_ANTHROPIC_URL: "https://api.anthropic.com/v1",
  UPSTREAM_ANTHROPIC_AUTH_HEADER: "x-api-key",
  UPSTREAM_ANTHROPIC_KEY: "sk-ant-secret-456",
});

const ORIGINS = ["http://localhost:5173"];

function app() {
  return createProxyHandler(UPSTREAMS, { allowedOrigins: ORIGINS });
}

describe("loadUpstreams", () => {
  it("parses UPSTREAM_<ID>_* triples and lowercases the id", () => {
    expect(UPSTREAMS.get("openai")).toEqual({
      id: "openai",
      url: "https://api.openai.com/v1",
      authHeader: "Authorization",
      key: "Bearer sk-secret-123",
    });
    expect(UPSTREAMS.get("anthropic")?.authHeader).toBe("x-api-key");
  });

  it("defaults the auth header and skips entries without a URL", () => {
    const m = loadUpstreams({ UPSTREAM_LOCAL_URL: "http://localhost:11434", UPSTREAM_NOPE_KEY: "x" });
    expect(m.get("local")).toEqual({
      id: "local",
      url: "http://localhost:11434",
      authHeader: "Authorization",
      key: "",
    });
    expect(m.has("nope")).toBe(false);
  });
});

describe("createProxyHandler — forwarding", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("data: hello\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("injects the server-side key and preserves the API subpath", async () => {
    const res = await app().request("/forward/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer client-should-be-dropped",
        [GALLEY_UPSTREAM_HEADER]: "openai",
      },
      body: '{"model":"gpt-4o"}',
    });
    expect(res.status).toBe(200);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = new Headers(init.headers);
    // The injected key replaces the client's authorization.
    expect(sent.get("authorization")).toBe("Bearer sk-secret-123");
    // The selector header is not forwarded upstream.
    expect(sent.has(GALLEY_UPSTREAM_HEADER)).toBe(false);
  });

  it("streams the upstream response body through verbatim", async () => {
    const res = await app().request("/forward/chat/completions", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: hello\n\n");
  });

  it("preserves query strings on the forwarded path", async () => {
    await app().request("/forward/models?limit=5", {
      method: "GET",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai" },
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/models?limit=5");
  });
});

describe("createProxyHandler — SSRF / no client-supplied URL", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope")));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an unknown upstream id with 400 and never calls fetch", async () => {
    const res = await app().request("/forward/x", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "evil" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("treats a client-supplied URL as an unknown id (no open relay)", async () => {
    const res = await app().request("/forward/x", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "http://169.254.169.254/latest/meta-data" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses when no upstream header is present", async () => {
    const res = await app().request("/forward/x", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("createProxyHandler — refuses upstream redirects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 502 on an upstream 302 and never leaks the Location target", async () => {
    const leakedHost = "http://internal.svc.cluster.local/secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: leakedHost } })),
    );
    const res = await app().request("/forward/chat/completions", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain(leakedHost);
  });
});

describe("createProxyHandler — CORS allowlist", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reflects an allowed origin", async () => {
    const res = await app().request("/forward/x", {
      method: "POST",
      headers: { origin: "http://localhost:5173", [GALLEY_UPSTREAM_HEADER]: "openai" },
      body: "{}",
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("does not authorize a disallowed origin", async () => {
    const res = await app().request("/forward/x", {
      method: "POST",
      headers: { origin: "http://evil.example", [GALLEY_UPSTREAM_HEADER]: "openai" },
      body: "{}",
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("http://evil.example");
  });
});

describe("createProxyHandler — never logs secrets or bodies", () => {
  it("keeps keys and request bodies out of all console output", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    try {
      await app().request("/forward/chat/completions", {
        method: "POST",
        headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/json" },
        body: '{"secretPrompt":"my private document"}',
      });
      const logged = spies.flatMap((s) => s.mock.calls.flat()).join(" ");
      expect(logged).not.toContain("sk-secret-123");
      expect(logged).not.toContain("my private document");
    } finally {
      vi.unstubAllGlobals();
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("createProxyHandler — optional bearer gate", () => {
  const TOKEN = "s3cret-edge-token";
  function gatedApp() {
    return createProxyHandler(UPSTREAMS, { allowedOrigins: ORIGINS, accessToken: TOKEN });
  }
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses /forward with 401 when the gate is set and no bearer is presented", async () => {
    const res = await gatedApp().request("/forward/chat/completions", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled(); // refused BEFORE the upstream key is injected
  });

  it("refuses 401 on a wrong bearer (no upstream call, key never injected)", async () => {
    const res = await gatedApp().request("/forward/chat/completions", {
      method: "POST",
      headers: {
        [GALLEY_UPSTREAM_HEADER]: "openai",
        authorization: "Bearer not-the-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards on the correct bearer, and the gate token is NOT sent upstream", async () => {
    const res = await gatedApp().request("/forward/chat/completions", {
      method: "POST",
      headers: {
        [GALLEY_UPSTREAM_HEADER]: "openai",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // The injected upstream key replaces the gate bearer — the token never leaks.
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-secret-123");
  });

  it("is OFF by default: no bearer required when accessToken is unset", async () => {
    const res = await app().request("/forward/chat/completions", {
      method: "POST",
      headers: { [GALLEY_UPSTREAM_HEADER]: "openai", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});
