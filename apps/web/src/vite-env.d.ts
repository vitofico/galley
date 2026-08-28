/// <reference types="vite/client" />

declare module "*.typ?raw" {
  const src: string;
  export default src;
}

/**
 * Serve-time runtime config (roadmap #5 slice 5 + 14-E), injected by
 * apps/web-server via a same-origin `/config.js` (`window.__GALLEY_CONFIG__ =
 * {…};`) when the operator sets `GALLEY_COMPILE_URL` and/or enables OIDC auth.
 * Absent in dev / `vite preview` / web-only deploys. OPERATOR config, trusted like build-time env — but consumers must
 * still treat the SHAPE as untrusted (read defensively) and pass any URL through
 * `validateCompileUrl` before use (see compiler-assets.ts).
 */
interface GalleyRuntimeConfig {
  /** Browser-reachable URL of the server-compile service. */
  readonly compileUrl?: string;
  /**
   * Browser-reachable `ws(s)://` URL of the collaboration sync relay. Set when
   * the relay is exposed at a per-deploy address (e.g. a `/sync` ingress path)
   * so a single shared image needn't bake a deployment-specific
   * `VITE_GALLEY_SYNC_URL`. Absent → the SPA derives `ws(s)://<page host>:1234`.
   */
  readonly syncUrl?: string;
  /** OIDC auth is active (14-E) — mirrors the web-server's auth-router mount. */
  readonly auth?: true;
}

interface Window {
  /** Present only when the runtime web-server injected `/config.js`. */
  readonly __GALLEY_CONFIG__?: GalleyRuntimeConfig;
}
