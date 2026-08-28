import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
// The built SPA bundle, served by BOTH `vite preview` and the real web-server below.
const WEB_DIST = resolve(HERE, "dist");
// Test-only @preview registry fixture (e2e/fixtures/registry): a node:http server
// + the committed integrity manifest the package-aware compile service verifies
// against. Used ONLY to prove the positive server package path hermetically.
const REGISTRY_DIR = resolve(HERE, "e2e/fixtures/registry");
const REGISTRY_INTEGRITY = resolve(REGISTRY_DIR, "integrity.json");

// Roadmap 23.3 — cross-browser SMOKE subset. The canonical green-gate runs the
// FULL suite on chromium only (the `e2e` script pins --project=chromium). A
// SEPARATE `e2e:cross` script selects the `firefox`/`webkit` projects below,
// which run ONLY this short list of specs — the ones that exercise the surface
// where Firefox/WebKit diverge from Chromium: app boot, the ~28 MB WASM compiler
// loading in a Web Worker, real glyph rendering (fonts), and IndexedDB
// persistence. Selected by FILE PATH so the spec files stay untouched.
const SMOKE = [
  // Editor → live-preview loop: app boot, WASM compiler ready, SVG render, and a
  // located diagnostic. The core happy path in a real browser.
  "**/preview.spec.ts",
  // Web Worker + bundled WASM + LOCAL fonts with zero external network: asserts
  // real glyph geometry (<path> count > 0). The strongest font/glyph canary.
  "**/offline.spec.ts",
  // IndexedDB persistence end-to-end (y-indexeddb): the save-state badge settles
  // to Saved, flips to Saving on an edit, then back to Saved.
  "**/save-state.spec.ts",
];

/**
 * E2E config. The web app is built first (CMD), then `vite preview` serves the
 * production bundle and Playwright drives headless Chromium against it. Timeouts
 * are generous because the worker loads a ~28 MB WASM compiler on first paint.
 *
 * A second server — the real `@galley/web-server` on :4178 — serves the SAME
 * bundle under the production `DEFAULT_CSP`. `vite preview` sets no CSP, so that
 * server is the only thing that exercises the runtime security policy against the
 * live compiler (see `e2e/web-server-csp.spec.ts`).
 */
export default defineConfig({
  testDir: "./e2e",
  // The capture-only harness is opt-in (run via the `capture` docker service with
  // CAPTURE=1), never part of the blocking green-gate. The gate run (no CAPTURE)
  // ignores it; the capture service sets CAPTURE=1 to include it.
  testIgnore: process.env.CAPTURE ? [] : ["**/ui-capture.spec.ts"],
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm preview --port 4173 --strictPort",
      port: 4173,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The collaboration sync server for the two-browser collab e2e (Phase 2c-2).
      // HTTP health endpoint on the same port makes readiness pollable.
      command: "pnpm --filter @galley/sync start",
      port: 1234,
      env: { PORT: "1234" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The server-side compile service for the ?serverCompile=1 e2e (roadmap #3).
      // Wait on /healthz (it loads WASM on boot); CORS-allow the preview origin.
      command: "pnpm --filter @galley/compile start",
      url: "http://localhost:3001/healthz",
      env: { PORT: "3001", ALLOWED_ORIGINS: "http://localhost:4173" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The test-only @preview registry fixture (node:http, no deps). Serves the
      // crafted fixture packages so the package-aware compile service below can
      // fetch+integrity-verify them OFFLINE (no real Universe / internet).
      command: "node e2e/fixtures/registry/server.mjs",
      url: "http://localhost:3101/healthz",
      env: { REGISTRY_PORT: "3101" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // A SECOND compile service (:3002) wired to the registry fixture above, so it
      // CAN resolve `@preview/…` imports (REGISTRY_BASE_URL + REGISTRY_INTEGRITY_FILE,
      // ADR-0016). Kept separate from the package-free :3001 instance so the existing
      // server-compile spec is undisturbed. Proves the POSITIVE package + figure
      // server-verify paths (package-routing / figure-server-compile specs).
      // First (re)generate the integrity manifest IN THIS ENVIRONMENT — Node's gzip
      // output is platform/version-specific, so the committed manifest can differ
      // from what the in-container registry server serves. The fixture build is
      // deterministic within one environment, so the registry server (same builder)
      // and this freshly-built manifest agree byte-for-byte. THEN start the service.
      command:
        "node e2e/fixtures/registry/build-packages.mjs && pnpm --filter @galley/compile start",
      url: "http://localhost:3002/healthz",
      env: {
        PORT: "3002",
        ALLOWED_ORIGINS: "http://localhost:4173",
        REGISTRY_BASE_URL: "http://localhost:3101",
        REGISTRY_INTEGRITY_FILE: REGISTRY_INTEGRITY,
        // Registry mode requires inline isolation: since worker became the default
        // (unset ⇒ worker), a registry-mode service must opt out explicitly or the
        // compile server refuses to start (worker + REGISTRY_BASE_URL is unsupported).
        GALLEY_COMPILE_ISOLATION: "inline",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The REAL runtime web-server (@galley/web-server) serving the same built
      // bundle (WEB_ROOT=dist) under its production DEFAULT_CSP. `vite preview`
      // above sets no CSP, so this is the only server that exercises the runtime
      // policy against the live compiler (see e2e/web-server-csp.spec.ts).
      command: "pnpm --filter @galley/web-server start",
      url: "http://localhost:4178/healthz",
      env: { PORT: "4178", WEB_ROOT: WEB_DIST },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    // The canonical gate. The `e2e` script pins `--project=chromium`, so the
    // green-gate runs EXACTLY this project over the full suite — byte-for-byte
    // unchanged from before 23.3. firefox/webkit are NEVER picked up by the gate
    // because they are selected only by the explicit `--project` flags in the
    // `e2e:cross` script (Playwright runs all `projects` only when none is named;
    // the gate always names chromium).
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Cross-browser smoke (23.3) — run ONLY via `pnpm e2e:cross`. `testMatch`
    // restricts each to the SMOKE subset above, so even when selected they run
    // just those high-value specs, never the full 110.
    { name: "firefox", testMatch: SMOKE, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testMatch: SMOKE, use: { ...devices["Desktop Safari"] } },
  ],
});
