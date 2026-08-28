/**
 * Roadmap #5 slice 1: the static web server core. Drives the real Hono app via
 * `app.request()` against an in-memory `StaticFiles` fake — no disk, fully
 * offline — proving the routing contract that the self-host runtime depends on:
 * exact-asset serving, content types, SPA navigation fallback, missing-asset
 * 404s (NOT fallback), path-traversal rejection, and the health endpoint.
 */
import { describe, it, expect } from "vitest";
import { createWebServerApp, toSafeRelPath, type StaticFiles } from "./index.js";

const enc = new TextEncoder();

/** An in-memory file tree keyed by safe relative path (no leading slash). */
function fakeFiles(tree: Record<string, string>): StaticFiles {
  return {
    read: async (relPath: string) => {
      const text = tree[relPath];
      return text === undefined ? null : enc.encode(text);
    },
  };
}

const SITE = fakeFiles({
  "index.html": "<!doctype html><title>Galley</title><div id=root></div>",
  "assets/app-abc123.js": "console.log('app')",
  "assets/app-abc123.css": "body{}",
  "typst.worker-xyz.js": "// worker",
  "favicon.ico": "icon-bytes",
});

function app() {
  return createWebServerApp({ files: SITE });
}

describe("apps/web-server static server", () => {
  it("reports healthy", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports 503 from /healthz when the SPA shell is unservable (no index.html)", async () => {
    const broken = createWebServerApp({ files: fakeFiles({ "assets/x.js": "1" }) });
    const res = await broken.request("/healthz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("serves index.html at the root with no-cache", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(await res.text()).toContain("Galley");
  });

  it("serves a hashed JS asset with the right content-type and a long immutable cache", async () => {
    const res = await app().request("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=31536000");
    expect(cc).toContain("immutable");
    expect(await res.text()).toBe("console.log('app')");
  });

  it("serves a CSS asset with the css content-type", async () => {
    const res = await app().request("/assets/app-abc123.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("sets X-Content-Type-Options: nosniff on served assets", async () => {
    const res = await app().request("/assets/app-abc123.js");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets defense-in-depth security headers on every response (incl. a WASM-safe CSP)", async () => {
    for (const path of ["/", "/assets/app-abc123.js"]) {
      const res = await app().request(path);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("permissions-policy"), path).toBeTruthy();
      const csp = res.headers.get("content-security-policy") ?? "";
      // typst WASM + the compile/agent Web Worker must keep working under the CSP.
      // typst.ts needs BOTH: 'wasm-unsafe-eval' to compile the WASM and 'unsafe-eval'
      // because its init evaluates a JS string (else the compiler hangs loading).
      expect(csp, path).toContain("'wasm-unsafe-eval'");
      expect(csp, path).toContain("'unsafe-eval'");
      expect(csp, path).toContain("worker-src 'self' blob:");
      expect(csp, path).toContain("frame-ancestors 'none'");
      // No COOP/COEP — the typst WASM needs none and COEP can break it.
      expect(res.headers.get("cross-origin-embedder-policy"), path).toBeNull();
      // Served assets keep their precise content-type alongside the security headers.
      if (path !== "/") expect(res.headers.get("content-type")).toContain("text/javascript");
    }
  });

  it("allows the CSP to be disabled/overridden via options (operator control)", async () => {
    const off = createWebServerApp({ files: SITE, csp: null });
    expect((await off.request("/")).headers.get("content-security-policy")).toBeNull();
    // Other security headers stay on even when CSP is disabled.
    expect((await off.request("/")).headers.get("x-frame-options")).toBe("DENY");

    const custom = createWebServerApp({ files: SITE, csp: "default-src 'none'" });
    expect((await custom.request("/")).headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("falls back to index.html for a client-side navigation route (no extension)", async () => {
    const res = await app().request("/projects/some-doc");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Galley");
  });

  it("falls back to index.html for every #19.4 app route (/library, /p/<id>, /join/<room>)", async () => {
    // Regression net for the Rail & Islands router (spec §5): a DIRECT load /
    // reload of a real path must serve the SPA shell, or deep links and the
    // share links (/join/<room>) break. The generic extensionless fallback
    // covers these; this pins each route (incl. query strings) explicitly.
    for (const path of [
      "/library",
      "/p/proj-123",
      "/p/proj-123?serverCompile=1",
      "/join/share-0d9f3a",
      "/join/share-0d9f3a?sync=ws%3A%2F%2Frelay%3A1234",
    ]) {
      const res = await app().request(path);
      expect(res.status, `GET ${path}`).toBe(200);
      expect(res.headers.get("content-type"), `GET ${path}`).toContain("text/html");
      expect(await res.text()).toContain("Galley");
    }
  });

  it("404s a MISSING asset (extensioned) instead of masking it with index.html", async () => {
    const res = await app().request("/assets/missing-deadbeef.js");
    expect(res.status).toBe(404);
  });

  it("toSafeRelPath: rejects traversal/NUL/backslash, normalizes safe paths (precise contract)", () => {
    // The pure normalizer is the directly-tested guarantee — any `..` segment is
    // rejected outright, NUL/backslash rejected, `.` and empty segments collapsed.
    expect(toSafeRelPath("/../secret")).toBeNull();
    expect(toSafeRelPath("/a/../b")).toBeNull();
    expect(toSafeRelPath("/assets/../../etc/passwd")).toBeNull();
    expect(toSafeRelPath("/%2e%2e/secret")).toBeNull(); // decodes to ".."
    expect(toSafeRelPath("/x/%00.js")).toBeNull(); // NUL
    expect(toSafeRelPath("/a\\b")).toBeNull(); // backslash
    expect(toSafeRelPath("/")).toBe("");
    expect(toSafeRelPath("/./assets/./app.js")).toBe("assets/app.js");
    expect(toSafeRelPath("/assets/app-abc123.js")).toBe("assets/app-abc123.js");
  });

  it("over HTTP, traversal can never escape the root — the URL layer resolves it in-root", async () => {
    // The WHATWG URL parser resolves `..` and `%2e%2e` dot-segments to an in-root
    // path BEFORE the handler runs, so a traversal attempt can only ever serve the
    // SPA shell (in-root nav) or 404 — never out-of-root bytes. `/secret` (no
    // ext) → index.html; `/missing.js` (ext) → 404. Neither leaks the "secret".
    for (const p of ["/../secret", "/%2e%2e/secret", "/assets/../../etc/passwd"]) {
      const res = await app().request(p);
      const body = await res.text();
      expect(res.status, `path ${p}`).not.toBe(500);
      // Only ever the known SPA shell or nothing — never a file outside the map.
      if (res.status === 200) expect(body).toContain("Galley");
    }
    // An extensioned resolved-in-root miss is a real 404 (not masked by index).
    expect((await app().request("/assets/../../missing.js")).status).toBe(404);
  });

  it("rejects a NUL byte and backslash in the path", async () => {
    for (const p of ["/assets/%00.js", "/assets%5c..%5csecret"]) {
      const res = await app().request(p);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("404s the health-shaped path is not confused with a route — /healthz is JSON not HTML", async () => {
    const res = await app().request("/healthz");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 404 when index.html itself is absent (misconfigured root) on a nav route", async () => {
    const bare = createWebServerApp({ files: fakeFiles({ "assets/x.js": "1" }) });
    const res = await bare.request("/some/route");
    expect(res.status).toBe(404);
  });

  it("serves EXACTLY the file bytes when the source is a pooled/offset view (Buffer footgun)", async () => {
    // Node's readFile returns a Buffer whose .buffer is a shared pool (e.g. 8 KiB)
    // at a non-zero byteOffset; naively sending `bytes.slice().buffer` would ship
    // the whole pool (corruption + adjacent-memory leak). Model that here: a view
    // with a non-zero byteOffset over a larger backing buffer padded with 0xAA.
    const want = enc.encode("EXACT-BODY-βγ");
    const backing = new Uint8Array(64).fill(0xaa);
    backing.set(want, 8);
    const view = backing.subarray(8, 8 + want.length); // byteOffset 8, shared 64-byte buffer
    expect(view.byteOffset).toBe(8);
    const server = createWebServerApp({ files: { read: async () => view } });
    const res = await server.request("/x.txt");
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(want.length); // not 64, not 8KiB
    expect([...got]).toEqual([...want]); // byte-for-byte, no padding/leak
  });

  it("HEAD on an asset returns headers and no body", async () => {
    const res = await app().request("/assets/app-abc123.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("");
  });

  it("rejects non-GET/HEAD methods with 405 + an Allow header", async () => {
    const res = await app().request("/", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});
