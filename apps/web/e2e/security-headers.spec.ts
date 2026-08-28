import { test, expect } from "@playwright/test";

/**
 * Production security-headers regression guard for the runtime web-server.
 *
 * `vite preview` (the default e2e server) sets none of these, so only the REAL
 * `@galley/web-server` on :4178 emits the production defense-in-depth headers.
 * This test drives that server directly and asserts the EXACT header values the
 * runtime sets in `apps/web-server/src/index.ts` (the `app.use("*")` middleware +
 * `DEFAULT_CSP`). If anyone weakens or drops a header, this turns red.
 *
 * Header values asserted here are quoted verbatim from `index.ts`:
 *   x-content-type-options: "nosniff"
 *   x-frame-options:        "DENY"
 *   referrer-policy:        "no-referrer"
 *   permissions-policy:     "camera=(), microphone=(), geolocation=(), browsing-topics=()"
 *   content-security-policy: DEFAULT_CSP (each directive checked below)
 */
const WEB_SERVER = "http://localhost:4178";

// Mirror of DEFAULT_CSP directives from apps/web-server/src/index.ts. Asserting
// the whole directive list (order-independent) keeps this honest without being
// brittle about the exact join() spacing.
const EXPECTED_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: http: ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
];

test("runtime web-server emits the production security headers on the document response", async ({ page }) => {
  const resp = await page.goto(`${WEB_SERVER}/`);
  expect(resp, "navigation to the runtime web-server returned no response").toBeTruthy();
  expect(resp!.status()).toBe(200);

  const headers = resp!.headers(); // header names are lower-cased by Playwright

  // Defense-in-depth headers — exact values from the index.ts middleware.
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toBe(
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );

  // The document is the SPA shell, served as HTML with nosniff re-applied per-file.
  expect(headers["content-type"]).toContain("text/html");

  // Content-Security-Policy: assert every DEFAULT_CSP directive is present.
  const csp = headers["content-security-policy"] ?? "";
  const present = csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  for (const directive of EXPECTED_CSP_DIRECTIVES) {
    expect(present, `CSP missing directive: ${directive}\nfull CSP: ${csp}`).toContain(directive);
  }
});

test("security headers are also present on a static asset response", async ({ request }) => {
  // The middleware sets these on EVERY response (not just the SPA shell). Verify
  // against the JSON health endpoint, which is a distinct route from the wildcard.
  const resp = await request.get(`${WEB_SERVER}/healthz`);
  expect(resp.status()).toBe(200);

  const headers = resp.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toBe(
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );
  expect(headers["content-security-policy"] ?? "").toContain("script-src 'self'");

  // /healthz returns JSON {"ok":true}.
  expect(headers["content-type"]).toContain("application/json");
  expect(await resp.json()).toEqual({ ok: true });
});
