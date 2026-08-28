import { useState } from "react";
import { createModelClient, privacyStatement } from "@galley/agent";
import type { ProviderCapabilities, ProviderConfig, ProviderKind } from "@galley/shared";

/**
 * Provider settings (docs/providers.md): configure a `ProviderConfig`, test the
 * connection (`probe()`), and see the honest privacy posture. The direct-mode
 * key lives in this browser only (localStorage, handled by the caller).
 */
/** OpenAI's hosted endpoint — the default base URL for cloud providers. */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Ollama's local OpenAI-compatible endpoint (docs/providers.md). */
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

export function ProviderSettings({
  config,
  onSave,
  onUseDemo,
}: {
  config: ProviderConfig | null;
  onSave: (config: ProviderConfig) => void;
  onUseDemo: () => void;
}) {
  const [kind, setKind] = useState<ProviderKind>(config?.kind ?? "openai-compatible");
  const [label, setLabel] = useState(config?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? OPENAI_DEFAULT_BASE_URL);
  const [model, setModel] = useState(config?.model ?? "");
  const [mode, setMode] = useState<"direct" | "proxy">(config?.transport.mode ?? "direct");
  const [apiKey, setApiKey] = useState(
    config?.transport.mode === "direct" ? (config.transport.apiKey ?? "") : "",
  );
  const [proxyUrl, setProxyUrl] = useState(
    config?.transport.mode === "proxy" ? config.transport.proxyUrl : "http://localhost:8787",
  );
  const [upstreamId, setUpstreamId] = useState(
    config?.transport.mode === "proxy" ? config.transport.upstreamId : "openai",
  );
  const [probe, setProbe] = useState<ProviderCapabilities | null>(null);
  const [probing, setProbing] = useState(false);

  // Ollama gets the SAME transport choice as every provider: DIRECT for an
  // Ollama on this machine (localhost), or PROXY to reach one on a server/cluster
  // through @galley/proxy (no CORS / mixed-content). `isOllama` only drives the
  // local-endpoint defaults + privacy framing below, not a forced transport.
  const isOllama = kind === "ollama";

  // The base URL to use when the field is left blank: Ollama's local endpoint is
  // well-known, so an empty field defaults to it rather than throwing "Invalid
  // URL" downstream (the AI SDK calls `new URL(baseUrl)` and an empty string is a
  // hard error). Cloud providers keep their explicit value.
  const effectiveBaseUrl = baseUrl.trim() || (isOllama ? OLLAMA_DEFAULT_BASE_URL : baseUrl);

  const selectKind = (next: ProviderKind) => {
    setKind(next);
    if (next === "ollama") {
      setMode("direct");
      // Pre-fill the local endpoint so "Test connection" works out of the box;
      // only overwrite an empty field or the leftover cloud default.
      if (baseUrl.trim() === "" || baseUrl.trim() === OPENAI_DEFAULT_BASE_URL) {
        setBaseUrl(OLLAMA_DEFAULT_BASE_URL);
      }
    } else if (baseUrl.trim() === OLLAMA_DEFAULT_BASE_URL) {
      // Leaving Ollama → restore the cloud default rather than stranding the
      // local URL on a cloud provider.
      setBaseUrl(OPENAI_DEFAULT_BASE_URL);
    }
  };

  const build = (): ProviderConfig => ({
    kind,
    label: label || kind,
    baseUrl: effectiveBaseUrl,
    model,
    isLocal: kind === "ollama",
    transport:
      mode === "direct"
        ? { mode: "direct", ...(apiKey ? { apiKey } : {}) }
        : { mode: "proxy", proxyUrl, upstreamId },
  });

  const testConnection = async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await createModelClient(build()).probe());
    } catch (err) {
      setProbe({
        reachable: false,
        supportsStreaming: false,
        supportsToolCalls: false,
        supportsImageInput: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProbing(false);
    }
  };

  return (
    <section className="settings" data-testid="provider-settings">
      <div className="settings-row">
        <label>Provider</label>
        <select
          value={kind}
          onChange={(e) => selectKind(e.target.value as ProviderKind)}
          data-testid="provider-kind"
        >
          <option value="openai-compatible">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
          <option value="ollama">Ollama (local)</option>
        </select>
      </div>
      <div className="settings-row">
        <label>Base URL</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={isOllama ? OLLAMA_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL}
          data-testid="provider-baseurl"
        />
      </div>
      <div className="settings-row">
        <label>Model</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o" data-testid="provider-model" />
      </div>
      <div className="settings-row">
        <label>Transport</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as "direct" | "proxy")} data-testid="provider-mode">
          <option value="direct">Direct</option>
          <option value="proxy">Proxy</option>
        </select>
      </div>
      <p className="settings-privacy" data-testid="provider-mode-hint">
        {isOllama
          ? "Direct: your browser calls Ollama on this machine (set OLLAMA_ORIGINS). Proxy: route through @galley/proxy to reach an Ollama on a server/cluster."
          : "Direct: your browser calls the endpoint (key stored here). Proxy: route through @galley/proxy so the key stays server-side and CORS is handled."}
      </p>
      {mode === "direct" ? (
        <div className="settings-row">
          <label>API key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="stored in this browser only"
            data-testid="provider-apikey"
          />
        </div>
      ) : (
        <>
          <div className="settings-row">
            <label>Proxy URL</label>
            <input value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} data-testid="provider-proxyurl" />
          </div>
          <div className="settings-row">
            <label>Upstream id</label>
            <input value={upstreamId} onChange={(e) => setUpstreamId(e.target.value)} data-testid="provider-upstream" />
          </div>
        </>
      )}

      <p className="settings-privacy" data-testid="provider-privacy">
        {privacyStatement(build())}
      </p>

      <div className="settings-actions">
        <button onClick={() => void testConnection()} disabled={probing} data-testid="provider-test">
          {probing ? "Testing…" : "Test connection"}
        </button>
        <button onClick={() => onSave(build())} disabled={!model} data-testid="provider-save">
          Use this provider
        </button>
        <button onClick={onUseDemo} data-testid="provider-use-demo">
          Use Demo
        </button>
      </div>

      {probe && (
        <p
          className={`settings-probe ${probe.reachable ? "ok" : "err"}`}
          data-testid="provider-probe-result"
        >
          {probe.reachable
            ? `✓ Reachable${probe.supportsToolCalls ? " · tool calls" : ""}${probe.supportsStreaming ? " · streaming" : ""}`
            : `✗ ${probe.error ?? "unreachable"}`}
        </p>
      )}
    </section>
  );
}
