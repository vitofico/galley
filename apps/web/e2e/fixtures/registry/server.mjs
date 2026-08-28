/**
 * Hermetic @preview-registry fixture SERVER (test-only) — node:http, no deps.
 *
 * Serves the crafted fixture packages built by `build-packages.mjs` at the exact
 * path the compile service's resolver fetches:
 *     GET {baseUrl}/preview/{name}-{version}.tar.gz   →  the gzipped ustar tarball
 * plus `GET /healthz` so Playwright can poll readiness. The bytes are built
 * in-memory at startup and are byte-identical to the committed artifacts +
 * `integrity.json` (the build is deterministic), so the compile service's
 * `verifyIntegrity` against that manifest passes.
 *
 * Wiring (playwright.config.ts):
 *   - this server listens on REGISTRY_PORT (default 3101);
 *   - apps/compile runs with REGISTRY_BASE_URL=http://localhost:<port> and
 *     REGISTRY_INTEGRITY_FILE pointed at the committed integrity.json.
 *
 * This is the OFFLINE substitute for Typst Universe: it never reaches the real
 * internet, and (like everything under e2e/) ships nowhere near the app bundle.
 */
import { createServer } from "node:http";
import { buildAll } from "./build-packages.mjs";

const port = Number.parseInt(process.env.REGISTRY_PORT ?? "3101", 10);
const { artifacts } = buildAll();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  // Only GET /preview/<file>.tar.gz is served; anything else is 404 (fail closed).
  const m = /^\/preview\/([A-Za-z0-9._-]+\.tar\.gz)$/.exec(url.pathname);
  if (req.method === "GET" && m && Object.prototype.hasOwnProperty.call(artifacts, m[1])) {
    const bytes = artifacts[m[1]];
    res.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": String(bytes.length),
    });
    res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[registry-fixture] serving on http://127.0.0.1:${port} (${Object.keys(artifacts).join(", ")})`);
});
