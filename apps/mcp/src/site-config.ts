/**
 * `--url <galley site>` discovery: turn the address a person already knows (the
 * page they open Galley at) into the sync-relay address the kernel needs.
 *
 * A deployment's relay is not derivable from its hostname: a self-host may put
 * it behind an ingress path (`wss://host/sync`) rather than on the dev port. The
 * web server already publishes the operator's choice in its same-origin
 * `/config.js` (`window.__GALLEY_CONFIG__ = {"syncUrl": …}`), which is exactly
 * what the browser reads. The kernel reads the same file, so both ends agree
 * without the operator copying a relay address by hand.
 *
 * Only the relay address is taken. The site's compile URL is deliberately NOT
 * adopted: the kernel POSTs the whole document on every compile and so only ever
 * talks to a loopback compile service (config.ts `validateCompileUrl`).
 *
 * TRUST: the site is the party the operator named, and it already decides which
 * relay the paired browser uses, so honouring its relay address grants it
 * nothing new. The address is still shape-checked, and an https site may not
 * downgrade the kernel to a cleartext `ws://` relay.
 */

/** The dev/default relay port the web app falls back to (apps/web/src/share.ts). */
const DEFAULT_SYNC_PORT = 1234;
const DISCOVERY_TIMEOUT_MS = 10_000;

type FetchLike = (
  input: string,
  init: { redirect: "error"; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function siteUrlFrom(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): { siteUrl: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let siteUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--url") {
      siteUrl = argv[++i] ?? "";
    } else if (arg.startsWith("--url=")) {
      siteUrl = arg.slice("--url=".length);
    } else {
      rest.push(arg);
    }
  }
  return { siteUrl: siteUrl ?? (env["GALLEY_MCP_URL"]?.trim() || undefined), rest };
}

/** The relay the web app derives when the operator configured none. */
function defaultSyncUrl(site: URL): string {
  const scheme = site.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${site.hostname}:${DEFAULT_SYNC_PORT}`;
}

/** Pull `syncUrl` out of a `/config.js` body; null when it declares none. */
export function syncUrlFromRuntimeConfig(body: string): string | null {
  const match = /^\s*window\.__GALLEY_CONFIG__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(body);
  if (!match) return null;
  let config: unknown;
  try {
    config = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  const url = (config as { syncUrl?: unknown } | null)?.syncUrl;
  return typeof url === "string" && url.trim() !== "" ? url.trim() : null;
}

/**
 * If the operator passed `--url` (or `GALLEY_MCP_URL`), discover the relay and
 * return argv with `--url` replaced by the equivalent `--sync`, so the pure
 * parser in config.ts stays the single place that validates a config. Without
 * `--url` the argv is returned untouched.
 */
export async function resolveSiteUrl(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  if (argv.includes("--help") || argv.includes("-h")) return [...argv];
  const { siteUrl, rest } = siteUrlFrom(argv, env);
  if (siteUrl === undefined) return [...argv];

  const hasSync =
    rest.some((a) => a === "--sync" || a.startsWith("--sync=")) ||
    (env["GALLEY_MCP_SYNC"]?.trim() ?? "") !== "";
  if (hasSync) {
    throw new Error("--url and --sync are mutually exclusive: pass the site OR the relay, not both");
  }

  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error(`--url is not a valid URL: ${JSON.stringify(siteUrl)}`);
  }
  if (site.protocol !== "https:" && site.protocol !== "http:") {
    throw new Error(`--url must be an http:// or https:// URL; got ${JSON.stringify(siteUrl)}`);
  }
  if (site.username !== "" || site.password !== "") {
    throw new Error("--url must not contain credentials (the kernel handles no secrets)");
  }

  let syncUrl: string | null = null;
  try {
    const response = await fetchImpl(new URL("/config.js", site).toString(), {
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    // 404 is a normal answer: a deployment with no runtime config serves no file.
    if (response.ok) syncUrl = syncUrlFromRuntimeConfig(await response.text());
    else if (response.status !== 404) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    throw new Error(
      `could not read ${site.origin}/config.js (${err instanceof Error ? err.message : String(err)}) ` +
        "— check --url, or pass the relay directly with --sync",
    );
  }

  syncUrl ??= defaultSyncUrl(site);
  if (!/^wss?:\/\//.test(syncUrl)) {
    throw new Error(`${site.origin}/config.js declares a relay that is not ws:// or wss://`);
  }
  if (site.protocol === "https:" && !syncUrl.startsWith("wss://")) {
    throw new Error(`${site.origin} is https but declares a cleartext ws:// relay — refusing to downgrade`);
  }
  console.error(`galley mcp kernel: ${site.origin} uses the sync relay ${syncUrl}`);
  return [...rest, `--sync=${syncUrl}`];
}
