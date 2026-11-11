/**
 * Hosted connector configuration (ADR-0033). Parsed once at startup; a bad
 * value throws, so a misconfigured service never starts half-working.
 *
 *   PORT                           listen port (default 8790)
 *   GALLEY_DATA_DIR                the web service's data volume: the token
 *                                  fingerprints and the connected-project
 *                                  registry are read from it (required)
 *   GALLEY_CONNECTOR_SYNC_URL      the relay, as the connector reaches it
 *                                  inside the deployment, e.g.
 *                                  ws://galley-sync (required)
 *   GALLEY_CONNECTOR_COMPILE_URL   the compile service, e.g.
 *                                  http://galley-compile (optional; without it
 *                                  the `compile` tool reports not_configured)
 *
 * Both URLs are OPERATOR configuration. Nothing a client sends ever becomes a
 * URL this service fetches.
 */
export const DEFAULT_CONNECTOR_PORT = 8790;

export interface HostedConfig {
  port: number;
  dataDir: string;
  syncUrl: string;
  compileUrl?: string;
}

type Env = Record<string, string | undefined>;

function serviceUrl(name: string, raw: string, protocols: string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (!protocols.includes(url.protocol))
    throw new Error(`${name} must start with ${protocols.join("// or ")}//`);
  if (url.username !== "" || url.password !== "")
    throw new Error(`${name} must not carry credentials`);
  if (url.search !== "" || url.hash !== "")
    throw new Error(`${name} must not carry a query or fragment`);
  return raw.replace(/\/+$/, "");
}

export function parseHostedConfig(env: Env): HostedConfig {
  const portRaw = env["PORT"]?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_CONNECTOR_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");

  const dataDir = env["GALLEY_DATA_DIR"]?.trim();
  if (!dataDir)
    throw new Error(
      "GALLEY_DATA_DIR is unset. The hosted connector reads access tokens and connected projects from the web service's data volume and cannot start without it.",
    );

  const syncRaw = env["GALLEY_CONNECTOR_SYNC_URL"]?.trim();
  if (!syncRaw)
    throw new Error(
      "GALLEY_CONNECTOR_SYNC_URL is unset. The hosted connector reads a project by joining its room on the relay and cannot start without it.",
    );
  const syncUrl = serviceUrl("GALLEY_CONNECTOR_SYNC_URL", syncRaw, [
    "ws:",
    "wss:",
  ]);

  const compileRaw = env["GALLEY_CONNECTOR_COMPILE_URL"]?.trim();
  const compileUrl = compileRaw
    ? serviceUrl("GALLEY_CONNECTOR_COMPILE_URL", compileRaw, [
        "http:",
        "https:",
      ])
    : undefined;

  return {
    port,
    dataDir,
    syncUrl,
    ...(compileUrl !== undefined ? { compileUrl } : {}),
  };
}
