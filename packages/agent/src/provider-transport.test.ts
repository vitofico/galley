import { describe, it, expect } from "vitest";
import { GALLEY_UPSTREAM_HEADER } from "@galley/shared";
import type { ProviderConfig } from "@galley/shared";
import {
  privacyPosture,
  privacyStatement,
  redactedConfig,
  resolveTransport,
} from "./provider-transport.js";

const openaiDirect: ProviderConfig = {
  kind: "openai-compatible",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  isLocal: false,
  transport: { mode: "direct", apiKey: "sk-secret" },
};

const anthropicDirect: ProviderConfig = {
  kind: "anthropic",
  label: "Claude",
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude-sonnet-4-6",
  isLocal: false,
  transport: { mode: "direct", apiKey: "sk-ant-secret" },
};

const ollamaLocal: ProviderConfig = {
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
  isLocal: true,
  transport: { mode: "direct" },
};

const openaiProxy: ProviderConfig = {
  kind: "openai-compatible",
  label: "OpenAI via proxy",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  isLocal: false,
  transport: { mode: "proxy", proxyUrl: "http://localhost:8787/", upstreamId: "openai" },
};

describe("resolveTransport — direct", () => {
  it("uses a Bearer token for openai-compatible", () => {
    expect(resolveTransport(openaiDirect)).toEqual({
      baseUrl: "https://api.openai.com/v1",
      headers: { authorization: "Bearer sk-secret" },
    });
  });

  it("uses x-api-key + version for anthropic", () => {
    const r = resolveTransport(anthropicDirect);
    expect(r.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.headers.authorization).toBeUndefined();
  });

  it("sends no auth header for a keyless local endpoint", () => {
    expect(resolveTransport(ollamaLocal)).toEqual({
      baseUrl: "http://localhost:11434/v1",
      headers: {},
    });
  });
});

describe("resolveTransport — proxy", () => {
  it("targets /forward with the upstream selector and NO key", () => {
    const r = resolveTransport(openaiProxy);
    expect(r.baseUrl).toBe("http://localhost:8787/forward");
    expect(r.headers[GALLEY_UPSTREAM_HEADER]).toBe("openai");
    // The key must never leave for the browser→proxy hop.
    expect(JSON.stringify(r)).not.toContain("sk-");
    expect(r.headers.authorization).toBeUndefined();
  });
});

describe("ollama via proxy — a self-hosted (server/cluster) Ollama", () => {
  // A deployed Galley reaches an in-cluster Ollama THROUGH @galley/proxy: the
  // browser can't call the cluster's internal/keyless endpoint directly (CORS +
  // mixed-content), so it selects a named upstream and the proxy forwards. This
  // is a supported topology — the transport layer must NOT coerce it to direct.
  const ollamaProxy: ProviderConfig = {
    kind: "ollama",
    label: "Ollama (cluster)",
    baseUrl: "http://localhost:11434/v1",
    model: "gpt-oss:120b-cloud",
    isLocal: true,
    transport: { mode: "proxy", proxyUrl: "https://galley.example/llm-token", upstreamId: "ollama" },
  };

  it("resolveTransport targets /forward with the upstream selector, no key", () => {
    const r = resolveTransport(ollamaProxy);
    expect(r.baseUrl).toBe("https://galley.example/llm-token/forward");
    expect(r.headers[GALLEY_UPSTREAM_HEADER]).toBe("ollama");
    expect(r.headers.authorization).toBeUndefined();
  });

  it("privacy copy is honest: own infrastructure, NOT 'stays on your machine'", () => {
    // Self-hosted → still local posture (never a third-party cloud)…
    expect(privacyPosture(ollamaProxy)).toBe("local");
    // …but the doc DOES leave the browser to the proxy, so don't claim otherwise.
    const copy = privacyStatement(ollamaProxy);
    expect(copy).not.toMatch(/stays on your machine/i);
    expect(copy).toContain("https://galley.example/llm-token");
    expect(copy).toMatch(/infrastructure you control/i);
  });
});

describe("privacy posture & copy", () => {
  it("classifies the three postures", () => {
    expect(privacyPosture(ollamaLocal)).toBe("local");
    expect(privacyPosture(openaiDirect)).toBe("cloud-direct");
    expect(privacyPosture(openaiProxy)).toBe("cloud-via-proxy");
  });

  it("writes honest statements that reflect each posture", () => {
    expect(privacyStatement(ollamaLocal)).toMatch(/stays on your machine/i);
    expect(privacyStatement(openaiDirect)).toContain("https://api.openai.com/v1");
    expect(privacyStatement(openaiProxy)).toContain("http://localhost:8787/");
    expect(privacyStatement(openaiProxy)).toMatch(/provider still sees/i);
  });
});

describe("redactedConfig", () => {
  it("strips the API key for logging", () => {
    const safe = redactedConfig(openaiDirect);
    expect(JSON.stringify(safe)).not.toContain("sk-secret");
    expect(safe.transport).toMatchObject({ mode: "direct", apiKey: "[redacted]" });
  });

  it("leaves proxy/local configs unchanged (no client key to redact)", () => {
    expect(redactedConfig(openaiProxy)).toEqual(openaiProxy);
    expect(redactedConfig(ollamaLocal)).toEqual(ollamaLocal);
  });
});
