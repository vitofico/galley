import { describe, it, expect } from "vitest";
import { listModels } from "./list-models.js";
import type { ProviderConfig } from "@galley/shared";

function jsonFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({ ok, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}
const throwingFetch: typeof fetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

const OLLAMA: ProviderConfig = {
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
  isLocal: true,
  transport: { mode: "direct" },
};
const OPENAI: ProviderConfig = {
  kind: "openai-compatible",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  isLocal: false,
  transport: { mode: "direct", apiKey: "sk-test" },
};
const ANTHROPIC: ProviderConfig = {
  kind: "anthropic",
  label: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude-opus-4-8",
  isLocal: false,
  transport: { mode: "direct", apiKey: "sk-ant" },
};

describe("listModels", () => {
  it("parses Ollama /api/tags (models[].name) and hits the host root (no /v1)", async () => {
    let calledUrl = "";
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "llama3" }, { name: "qwen2" }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await listModels(OLLAMA, fetchImpl);
    expect(r).toEqual({ ok: true, models: ["llama3", "qwen2"] });
    expect(calledUrl).toBe("http://localhost:11434/api/tags");
  });

  it("parses an OpenAI-compatible /models (data[].id)", async () => {
    const r = await listModels(OPENAI, jsonFetch({ object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }));
    expect(r).toEqual({ ok: true, models: ["gpt-4o", "gpt-4o-mini"] });
  });

  it("parses Anthropic /models (data[].id) and sends the version + browser-access headers", async () => {
    let sent: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      sent = init.headers;
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-opus-4-8" }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await listModels(ANTHROPIC, fetchImpl);
    expect(r).toEqual({ ok: true, models: ["claude-opus-4-8"] });
    expect(sent["x-api-key"]).toBe("sk-ant");
    expect(sent["anthropic-version"]).toBe("2023-06-01");
    expect(sent["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("reports `unsupported` for proxy transport (the proxy has no models endpoint)", async () => {
    const proxied: ProviderConfig = {
      ...OPENAI,
      transport: { mode: "proxy", proxyUrl: "http://localhost:8080", upstreamId: "openai" },
    };
    const r = await listModels(proxied, throwingFetch);
    expect(r).toEqual({ ok: false, reason: "unsupported" });
  });

  it("fails closed: network throw → network; non-2xx → server; junk body → malformed", async () => {
    expect(await listModels(OPENAI, throwingFetch)).toEqual({ ok: false, reason: "network" });
    expect(await listModels(OPENAI, jsonFetch({}, false, 401))).toEqual({ ok: false, reason: "server" });
    expect(await listModels(OPENAI, jsonFetch({ nope: 1 }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("never sends auth headers for Ollama, even if a stale config carries an apiKey", async () => {
    let sent: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      sent = init.headers;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ models: [{ name: "llama3" }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const stale: ProviderConfig = { ...OLLAMA, transport: { mode: "direct", apiKey: "leaked" } };
    await listModels(stale, fetchImpl);
    expect(sent.authorization).toBeUndefined();
    expect(Object.values(sent).some((v) => v.includes("leaked"))).toBe(false);
  });

  it("rejects an oversized body up front via Content-Length", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "9999999" }),
        json: async () => ({ data: [{ id: "x" }] }),
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await listModels(OPENAI, fetchImpl)).toEqual({ ok: false, reason: "malformed" });
  });

  it("dedupes, drops non-strings/blank/over-long ids, and caps the list", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}` }));
    const r = await listModels(OPENAI, jsonFetch({ data: [{ id: "a" }, { id: "a" }, { id: "" }, { id: 5 }, ...many] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.models[0]).toBe("a");
      expect(r.models.filter((m) => m === "a")).toHaveLength(1);
      expect(r.models.length).toBeLessThanOrEqual(500);
    }
  });
});
