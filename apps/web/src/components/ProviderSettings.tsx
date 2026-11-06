import { useEffect, useId, useRef, useState } from "react";
import { createModelClient, listModels, privacyStatement } from "@galley/agent";
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderKind,
} from "@galley/shared";

/**
 * Provider settings (docs/providers.md): configure a `ProviderConfig`, test the
 * connection (`probe()`), and see the honest privacy posture. The direct-mode
 * key lives in this browser only (localStorage, handled by the caller).
 */
// Suggestions remain editable: compatible servers and installed Ollama models vary.
const PRESETS = {
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-6.1-terra",
    upstreamId: "openai",
    models: ["gpt-6.1-terra", "gpt-4o", "gpt-4o-mini"],
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-5-5",
    upstreamId: "anthropic",
    models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "",
    upstreamId: "ollama",
    models: [],
  },
} satisfies Record<
  ProviderKind,
  { baseUrl: string; model: string; upstreamId: string; models: string[] }
>;

type ProviderDraft = {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  upstreamId: string;
};

export function ProviderSettings({
  config,
  onSave,
  onUseDemo,
}: {
  config: ProviderConfig | null;
  onSave: (config: ProviderConfig) => void;
  onUseDemo: () => void;
}) {
  const [kind, setKind] = useState<ProviderKind>(
    config?.kind ?? "openai-compatible",
  );
  const preset = PRESETS[kind];
  const [label, setLabel] = useState(config?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? preset.baseUrl);
  const [model, setModel] = useState(config?.model ?? preset.model);
  const [mode, setMode] = useState<"direct" | "proxy">(
    config?.transport.mode ?? "direct",
  );
  const [apiKey, setApiKey] = useState(
    config?.transport.mode === "direct" ? (config.transport.apiKey ?? "") : "",
  );
  const [proxyUrl, setProxyUrl] = useState(
    config?.transport.mode === "proxy"
      ? config.transport.proxyUrl
      : "http://localhost:8787",
  );
  const [upstreamId, setUpstreamId] = useState(
    config?.transport.mode === "proxy"
      ? config.transport.upstreamId
      : preset.upstreamId,
  );
  const [probe, setProbe] = useState<ProviderCapabilities | null>(null);
  const [probing, setProbing] = useState(false);

  const drafts = useRef<Partial<Record<ProviderKind, ProviderDraft>>>({});
  const modelListId = useId();
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelStatus, setModelStatus] = useState("");
  const probeRequest = useRef(0);
  const modelsRequest = useRef(0);
  const isOllama = kind === "ollama";
  const effectiveBaseUrl = baseUrl.trim() || preset.baseUrl;

  // A result belongs to the exact settings tested, never a later selection.
  useEffect(() => {
    probeRequest.current++;
    setProbe(null);
    setProbing(false);
    return () => {
      probeRequest.current++;
    };
  }, [kind, baseUrl, model, mode, apiKey, proxyUrl, upstreamId]);
  useEffect(() => {
    modelsRequest.current++;
    setModels([]);
    setModelStatus("");
    setLoadingModels(false);
    return () => {
      modelsRequest.current++;
    };
  }, [kind, baseUrl, mode, apiKey, proxyUrl, upstreamId]);

  const selectKind = (next: ProviderKind) => {
    if (next === kind) return;
    drafts.current[kind] = { label, baseUrl, model, apiKey, upstreamId };
    const draft = drafts.current[next] ?? {
      ...PRESETS[next],
      label: "",
      apiKey: "",
    };
    setKind(next);
    setLabel(draft.label);
    setBaseUrl(draft.baseUrl);
    setModel(draft.model);
    setApiKey(draft.apiKey);
    setUpstreamId(draft.upstreamId);
    // Keep the chosen transport and proxy URL: the same cluster proxy can
    // serve multiple named upstreams. Credentials stay with their provider.
  };

  const build = (): ProviderConfig => ({
    kind,
    label: label || kind,
    baseUrl: effectiveBaseUrl,
    model: model.trim(),
    isLocal: kind === "ollama",
    transport:
      mode === "direct"
        ? { mode: "direct", ...(apiKey ? { apiKey } : {}) }
        : { mode: "proxy", proxyUrl, upstreamId },
  });

  const testConnection = async () => {
    const request = ++probeRequest.current;
    setProbing(true);
    setProbe(null);
    try {
      const result = await createModelClient(build()).probe();
      if (request === probeRequest.current) setProbe(result);
    } catch (err) {
      if (request === probeRequest.current)
        setProbe({
          reachable: false,
          supportsStreaming: false,
          supportsToolCalls: false,
          supportsImageInput: false,
          error: err instanceof Error ? err.message : String(err),
        });
    } finally {
      if (request === probeRequest.current) setProbing(false);
    }
  };

  const loadModels = async () => {
    const request = ++modelsRequest.current;
    setLoadingModels(true);
    setModelStatus("");
    const result = await listModels(build(), (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
    );
    if (request !== modelsRequest.current) return;
    setLoadingModels(false);
    if (result.ok) {
      setModels(result.models);
      setModelStatus(
        result.models.length
          ? "Available models loaded. Choose a model or enter its ID."
          : "No models returned. Enter a model ID manually.",
      );
    } else {
      setModelStatus(
        "Could not load models. Check the endpoint and credentials, or enter a model ID manually.",
      );
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
          placeholder={preset.baseUrl}
          data-testid="provider-baseurl"
        />
      </div>
      <div className="settings-row">
        <label htmlFor={`${modelListId}-input`}>Model</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          id={`${modelListId}-input`}
          list={modelListId}
          placeholder={isOllama ? "Enter an installed model ID" : preset.model}
          data-testid="provider-model"
        />
        <datalist id={modelListId} data-testid="provider-model-options">
          {[
            ...new Set([
              ...(model ? [model] : []),
              ...models,
              ...preset.models,
            ]),
          ].map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        {mode === "direct" ? (
          <div className="settings-actions">
            <button
              onClick={() => void loadModels()}
              disabled={loadingModels}
              data-testid="provider-load-models"
            >
              {loadingModels ? "Loading…" : "Load available models"}
            </button>
          </div>
        ) : (
          <p>
            Model suggestions are editable. Your proxy’s upstream determines
            which models are available.
          </p>
        )}
        {modelStatus && (
          <p role="status" data-testid="provider-model-status">
            {modelStatus}
          </p>
        )}
      </div>
      <div className="settings-row">
        <label>Transport</label>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as "direct" | "proxy")}
          data-testid="provider-mode"
        >
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
            <input
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              data-testid="provider-proxyurl"
            />
          </div>
          <div className="settings-row">
            <label>Upstream id</label>
            <input
              value={upstreamId}
              onChange={(e) => setUpstreamId(e.target.value)}
              data-testid="provider-upstream"
            />
          </div>
        </>
      )}

      <p className="settings-privacy" data-testid="provider-privacy">
        {privacyStatement(build())}
      </p>

      <div className="settings-actions">
        <button
          onClick={() => void testConnection()}
          disabled={probing}
          data-testid="provider-test"
        >
          {probing ? "Testing…" : "Test connection"}
        </button>
        <button
          onClick={() => onSave(build())}
          disabled={!model.trim()}
          data-testid="provider-save"
        >
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
