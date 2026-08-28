/**
 * Roadmap #5 slice 5: serve-time runtime config for the server-compile URL.
 *
 * Drives the real Hono app against the in-memory `StaticFiles` fake (no disk,
 * no network) and pins the WHOLE contract:
 *   - configured → GET /config.js serves `window.__GALLEY_CONFIG__ = {…};` as
 *     application/javascript, no-cache, nosniff, AND the served index.html gets
 *     a `<script src="/config.js"></script>` tag injected in the head BEFORE the
 *     bundle script (root, explicit index, and SPA-fallback alike);
 *   - hostile env values (quotes, </script>, newlines, U+2028/9) can NEVER break
 *     out of the JS string literal — shape-pinned + parse round-tripped;
 *   - absent / empty / whitespace env → byte-for-byte today's behavior: 404 on
 *     /config.js and an UNMODIFIED shell (the no-dead-toggle pin);
 *   - assets / other HTML files are never rewritten; CSP stays the strict
 *     `script-src 'self'` policy (same-origin /config.js needs no weakening).
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createWebServerApp,
  injectRuntimeConfigTag,
  renderRuntimeConfigScript,
  DEFAULT_CSP,
  RUNTIME_CONFIG_TAG,
  type StaticFiles,
} from "./index.js";

const enc = new TextEncoder();

const INDEX_HTML = [
  "<!doctype html>",
  "<html>",
  '<head><meta charset="utf-8"><title>Galley</title>',
  '<script type="module" src="/assets/app-abc123.js"></script>',
  "</head>",
  "<body><div id=root></div></body>",
  "</html>",
].join("\n");

function fakeFiles(tree: Record<string, string>): StaticFiles {
  return {
    read: async (relPath: string) => {
      const text = tree[relPath];
      return text === undefined ? null : enc.encode(text);
    },
  };
}

const TREE = {
  "index.html": INDEX_HTML,
  "assets/app-abc123.js": "console.log('app')",
  "other.html": "<html><head></head><body>other</body></html>",
};

const URL_OK = "http://compile.example.com/compile";

function appWith(compileUrl?: string | null) {
  return createWebServerApp({ files: fakeFiles(TREE), compileUrl });
}

/** An app with the auth router mounted (14-E: the flag mirrors the mount). */
function appWithAuth(compileUrl?: string | null) {
  return createWebServerApp({ files: fakeFiles(TREE), compileUrl, authRouter: new Hono() });
}

/**
 * Round-trip the /config.js body: pin the EXACT statement shape
 * (`window.__GALLEY_CONFIG__ = <expr>;\n`) and parse `<expr>` back with
 * JSON.parse. Valid JSON whose raw text contains no `<`/`>`/line-terminator
 * bytes (asserted separately below) is always an inert, valid JS object
 * expression — so shape + parse + no-breakout-bytes together prove the emitted
 * script assigns exactly the original value and nothing else. (A real-browser
 * execution of an injected config global is covered by the runtime-config e2e
 * spec; we deliberately avoid `new Function` here — repo lint forbids it.)
 */
function evalConfig(body: string): unknown {
  const m = /^window\.__GALLEY_CONFIG__ = (.*);\n$/.exec(body);
  if (!m) throw new Error(`unexpected /config.js body shape: ${body}`);
  return JSON.parse(m[1] as string);
}

describe("runtime config: /config.js (configured)", () => {
  it("serves window.__GALLEY_CONFIG__ with the compile URL as application/javascript", async () => {
    const res = await appWith(URL_OK).request("/config.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    const body = await res.text();
    expect(body).toBe(`window.__GALLEY_CONFIG__ = {"compileUrl":"${URL_OK}"};\n`);
    expect(evalConfig(body)).toEqual({ compileUrl: URL_OK });
  });

  it("serves no-cache + nosniff + the regular security headers (incl. the strict CSP)", async () => {
    const res = await appWith(URL_OK).request("/config.js");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // The CSP is NOT weakened for the config: same-origin script under 'self'.
    expect(res.headers.get("content-security-policy")).toBe(DEFAULT_CSP);
  });

  it("answers HEAD /config.js with headers and no body", async () => {
    const res = await appWith(URL_OK).request("/config.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  it("rejects mutating methods on /config.js with 405 (read-only server)", async () => {
    const res = await appWith(URL_OK).request("/config.js", { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("runtime config: escaping (env → JS string literal, hostile values)", () => {
  // The value is OPERATOR env (trusted), but the emitter must still make
  // breakout impossible: each hostile value must round-trip EXACTLY through the
  // emitted JS and the raw body must never contain a script-terminating or
  // statement-breaking byte sequence.
  const hostile = [
    'http://x/"};window.pwned=1;//', // quote + brace breakout attempt
    "http://x/</script><script>alert(1)</script>", // script-tag termination
    "http://x/a\nwindow.pwned=1", // raw newline → statement break
    "http://x/a\u2028b\u2029c", // legacy JS line terminators
    "http://x/\\backslash\"and'quotes", // backslash + mixed quotes
  ];

  for (const value of hostile) {
    it(`round-trips and contains no breakout: ${JSON.stringify(value).slice(0, 40)}…`, () => {
      const body = renderRuntimeConfigScript({ compileUrl: value });
      // Evaluates cleanly and assigns the EXACT original string.
      expect(evalConfig(body)).toEqual({ compileUrl: value });
      // No raw </script (any casing), no raw < or > at all, no raw line breaks
      // inside the literal (the only newline is the trailing one we emit), and
      // no raw U+2028/U+2029.
      expect(body.toLowerCase()).not.toContain("</script");
      expect(body).not.toMatch(/[<>\u2028\u2029]/);
      expect(body.indexOf("\n")).toBe(body.length - 1);
      // Exactly one statement of the pinned shape.
      expect(body).toMatch(/^window\.__GALLEY_CONFIG__ = \{.*\};\n$/);
    });
  }

  it("served end-to-end, a hostile env value stays inert in the body", async () => {
    const value = "http://x/</script><script>alert(1)</script>";
    const res = await appWith(value).request("/config.js");
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("</script");
    expect(evalConfig(body)).toEqual({ compileUrl: value });
  });
});

describe("runtime config: index.html tag injection (configured)", () => {
  for (const path of ["/", "/index.html", "/library", "/p/proj-123"]) {
    it(`injects the /config.js tag into the head, BEFORE the bundle script: GET ${path}`, async () => {
      const res = await appWith(URL_OK).request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      const tagAt = html.indexOf(RUNTIME_CONFIG_TAG);
      const headAt = html.indexOf("<head>");
      const bundleAt = html.indexOf('<script type="module"');
      expect(tagAt, "tag present").toBeGreaterThan(-1);
      expect(tagAt, "inside head").toBeGreaterThan(headAt);
      expect(tagAt, "before the bundle script").toBeLessThan(bundleAt);
      // Injected exactly once.
      expect(html.indexOf(RUNTIME_CONFIG_TAG, tagAt + 1)).toBe(-1);
    });
  }

  it("keeps the index.html no-cache posture on the injected shell", async () => {
    const res = await appWith(URL_OK).request("/");
    expect(res.headers.get("cache-control")).toContain("no-cache");
  });

  it("never rewrites assets or other HTML files", async () => {
    const js = await appWith(URL_OK).request("/assets/app-abc123.js");
    expect(await js.text()).toBe(TREE["assets/app-abc123.js"]);
    const other = await appWith(URL_OK).request("/other.html");
    expect(await other.text()).toBe(TREE["other.html"]);
  });

  it("injectRuntimeConfigTag falls back sanely without a <head> (before first script, else prepend)", () => {
    const noHead = '<html><body><script src="/a.js"></script></body></html>';
    const injected = injectRuntimeConfigTag(noHead);
    expect(injected.indexOf(RUNTIME_CONFIG_TAG)).toBeLessThan(injected.indexOf('<script src="/a.js">'));
    expect(injectRuntimeConfigTag("<p>x</p>")).toBe(`${RUNTIME_CONFIG_TAG}<p>x</p>`);
    // Attribute-carrying <head> tags are matched too.
    const attrHead = '<head lang="en"><script type="module" src="/b.js"></script></head>';
    const injectedAttr = injectRuntimeConfigTag(attrHead);
    expect(injectedAttr.startsWith(`<head lang="en">${RUNTIME_CONFIG_TAG}`)).toBe(true);
  });
});

describe("runtime config: ABSENT env = byte-for-byte today's behavior (the pin)", () => {
  // Empty and whitespace-only env values MUST behave exactly like unset —
  // compose passes `GALLEY_COMPILE_URL=${GALLEY_COMPILE_URL:-}` so a web-only
  // `docker compose up` must not advertise a dead compile server.
  const absentVariants: Array<[string, string | null | undefined]> = [
    ["unset", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   \t "],
  ];

  for (const [label, value] of absentVariants) {
    it(`${label}: /config.js is 404 and the shell is unmodified`, async () => {
      const app = appWith(value);
      expect((await app.request("/config.js")).status).toBe(404);
      // Root, explicit index, and the SPA fallback all serve the EXACT build bytes.
      for (const path of ["/", "/index.html", "/library"]) {
        const res = await app.request(path);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toBe(INDEX_HTML);
      }
    });
  }

  it("unset: SPA fallback, missing-asset 404 and /healthz are untouched", async () => {
    const app = appWith(undefined);
    expect((await app.request("/assets/missing-deadbeef.js")).status).toBe(404);
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });
});

describe("runtime config: the auth flag (14-E)", () => {
  // The flag mirrors the auth-router mount EXACTLY: the SPA must never probe
  // /auth/me to detect auth (auth-off falls through to the SPA wildcard and
  // returns index.html 200) — it trusts this server-rendered flag instead.
  it("auth only (no compile URL): /config.js serves {auth:true} and the tag is injected", async () => {
    const app = appWithAuth();
    const res = await app.request("/config.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toBe('window.__GALLEY_CONFIG__ = {"auth":true};\n');
    expect(evalConfig(body)).toEqual({ auth: true });
    // The shell gets the same head-injected tag as the compile-URL path.
    for (const path of ["/", "/index.html", "/library"]) {
      const html = await (await app.request(path)).text();
      expect(html.indexOf(RUNTIME_CONFIG_TAG), path).toBeGreaterThan(-1);
    }
  });

  it("auth + compile URL: one config object carries both keys", async () => {
    const res = await appWithAuth(URL_OK).request("/config.js");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(`window.__GALLEY_CONFIG__ = {"compileUrl":"${URL_OK}","auth":true};\n`);
    expect(evalConfig(body)).toEqual({ compileUrl: URL_OK, auth: true });
  });

  it("compile URL only: the auth key is NEVER emitted (no false advertising)", async () => {
    const body = await (await appWith(URL_OK).request("/config.js")).text();
    expect(body).not.toContain("auth");
    expect(evalConfig(body)).toEqual({ compileUrl: URL_OK });
  });

  it("neither: byte-for-byte today's behavior (404 config, unmodified shell)", async () => {
    const app = appWith(undefined);
    expect((await app.request("/config.js")).status).toBe(404);
    expect(await (await app.request("/")).text()).toBe(INDEX_HTML);
  });

  it("renderRuntimeConfigScript omits absent keys outright", () => {
    expect(renderRuntimeConfigScript({ auth: true })).toBe(
      'window.__GALLEY_CONFIG__ = {"auth":true};\n',
    );
    expect(renderRuntimeConfigScript({ compileUrl: URL_OK })).toBe(
      `window.__GALLEY_CONFIG__ = {"compileUrl":"${URL_OK}"};\n`,
    );
    expect(renderRuntimeConfigScript({ compileUrl: URL_OK, auth: true })).toBe(
      `window.__GALLEY_CONFIG__ = {"compileUrl":"${URL_OK}","auth":true};\n`,
    );
  });
});

describe("runtime config: the sync-relay URL (GALLEY_SYNC_URL)", () => {
  const SYNC_OK = "wss://galley.example/sync";

  it("serves syncUrl in /config.js when set, normalizing empty/whitespace to absent", async () => {
    const app = createWebServerApp({ files: fakeFiles(TREE), syncUrl: SYNC_OK });
    const body = await (await app.request("/config.js")).text();
    expect(body).toBe(`window.__GALLEY_CONFIG__ = {"syncUrl":"${SYNC_OK}"};\n`);
    expect(evalConfig(body)).toEqual({ syncUrl: SYNC_OK });

    // Empty/whitespace is treated as absent — no dead relay advertised, and with
    // nothing else configured /config.js 404s exactly like today.
    const blank = createWebServerApp({ files: fakeFiles(TREE), syncUrl: "   " });
    expect((await blank.request("/config.js")).status).toBe(404);
  });

  it("emits keys in deterministic order: compileUrl, syncUrl, then auth", () => {
    expect(renderRuntimeConfigScript({ compileUrl: URL_OK, syncUrl: SYNC_OK, auth: true })).toBe(
      `window.__GALLEY_CONFIG__ = {"compileUrl":"${URL_OK}","syncUrl":"${SYNC_OK}","auth":true};\n`,
    );
    // Present alone, it is the only key.
    expect(renderRuntimeConfigScript({ syncUrl: SYNC_OK })).toBe(
      `window.__GALLEY_CONFIG__ = {"syncUrl":"${SYNC_OK}"};\n`,
    );
  });
});
