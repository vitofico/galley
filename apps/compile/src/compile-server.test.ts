/**
 * Roadmap #3 slice 3: the apps/compile skeleton. Drives the real Hono app with a
 * real Node `TypstEngine` (real WASM, no network) via `app.request()`, proving the
 * HTTP compile contract end-to-end against the same wire types slice 2's client
 * speaks.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { base64ToBytes } from "@galley/compiler";
import type { CheckResult, ExportResultWire, ProjectInput, RenderResult } from "@galley/shared";
import { createCachedReadiness, createCompileApp, parseMaxConcurrentCompiles } from "./index.js";
import { createNodeEngine } from "./engine.js";
import { CompileUnavailableError } from "./isolated-backend.js";

let app: ReturnType<typeof createCompileApp>;

beforeAll(async () => {
  const engine = await createNodeEngine();
  app = createCompileApp({ backend: engine });
}, 60_000);

async function post(body: unknown): Promise<Response> {
  return app.request("/compile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("apps/compile service", () => {
  it("reports healthy", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a malformed input with a clean 400 (not a 500 crash)", async () => {
    // `input: null` and `input: 123` are untrusted bodies that must NOT reach the
    // ProjectInput guard's field dereferences (which would throw a TypeError and
    // surface as a 500). They take the clean 400 path instead.
    for (const bad of [null, 123]) {
      const res = await post({ op: "check", input: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "input must be a source string or a ProjectInput",
      });
    }
  });

  it("checks a good document cleanly", async () => {
    const res = await post({ op: "check", input: "= Hello\nBody." });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CheckResult;
    expect(body.ok).toBe(true);
    expect(body.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("returns a located error for a broken document", async () => {
    const res = await post({ op: "check", input: "= Title\n#let x =\nbody" });
    const body = (await res.json()) as CheckResult;
    expect(body.ok).toBe(false);
    const err = body.diagnostics.find((d) => d.severity === "error");
    expect(err?.span?.start.line).toBe(2);
  });

  it("renders an SVG", async () => {
    const res = await post({ op: "render", input: "= Heading\nText." });
    const body = (await res.json()) as RenderResult;
    expect(body.ok).toBe(true);
    expect(body.pages[0]!.svg).toContain("<svg");
  });

  it("exports a real PDF (base64 on the wire)", async () => {
    const res = await post({ op: "export", input: "= Doc\nText." });
    const body = (await res.json()) as ExportResultWire;
    expect(body.ok).toBe(true);
    expect(body.pdfBase64).not.toBeNull();
    const pdf = base64ToBytes(body.pdfBase64!);
    // "%PDF-" magic.
    expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it("compiles a multi-file project (virtual #import resolves)", async () => {
    const project: ProjectInput = {
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: `#import "/intro.typ": intro\n#intro()\n` },
        { path: "/intro.typ", text: `#let intro() = [Introduction]\n` },
      ],
    };
    const res = await post({ op: "check", input: project });
    const body = (await res.json()) as CheckResult;
    expect(body.ok).toBe(true);
  });

  it("rejects an unknown op with 400", async () => {
    const res = await post({ op: "explode", input: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed input with 400", async () => {
    const res = await post({ op: "check", input: { not: "valid" } });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await app.request("/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("apps/compile input caps (DoS guard, slice 4)", () => {
  // Caps reject before the backend, so a fake (never-called) backend suffices.
  const okResult = { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };
  const fakeBackend = {
    check: async () => okResult,
    render: async () => ({ ok: true, diagnostics: [], pages: [], durationMs: 0 }),
    export: async () => ({ ok: true, diagnostics: [], pdf: null }),
  };
  const tiny = createCompileApp({
    backend: fakeBackend,
    limits: { maxRequestBytes: 200, maxFiles: 2, maxFileBytes: 50, maxTotalBytes: 80 },
  });
  const tinyPost = (body: unknown) =>
    tiny.request("/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("413s a request body over the byte cap", async () => {
    const res = await tinyPost({ op: "check", input: "x".repeat(500) });
    expect(res.status).toBe(413);
  });

  it("413s a single source over the per-file cap", async () => {
    const res = await tinyPost({ op: "check", input: "y".repeat(120) }); // < 200 req, > 50 file
    expect(res.status).toBe(413);
  });

  it("413s a project with too many files", async () => {
    const project = {
      kind: "project",
      main: "/a.typ",
      files: [
        { path: "/a.typ", text: "a" },
        { path: "/b.typ", text: "b" },
        { path: "/c.typ", text: "c" },
      ],
    };
    const res = await tinyPost({ op: "check", input: project });
    expect(res.status).toBe(413);
  });

  it("413s a project over the total size cap", async () => {
    const project = {
      kind: "project",
      main: "/a.typ",
      files: [
        { path: "/a.typ", text: "a".repeat(45) },
        { path: "/b.typ", text: "b".repeat(45) }, // 90 total > 80 cap
      ],
    };
    const res = await tinyPost({ op: "check", input: project });
    expect(res.status).toBe(413);
  });

  it("allows an input within all caps", async () => {
    const res = await tinyPost({ op: "check", input: "ok" });
    expect(res.status).toBe(200);
  });
});

describe("apps/compile concurrency cap (SEC: /compile DoS)", () => {
  const okResult = { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };

  // A backend whose check() blocks on a gate, so we can hold N compiles in-flight
  // and probe the cap deterministically (no timer races).
  function gatedBackend() {
    const gates: Array<() => void> = [];
    let started = 0;
    let waiters: Array<() => void> = [];
    const notify = () => {
      const ws = waiters;
      waiters = [];
      for (const w of ws) w();
    };
    const backend = {
      check: () =>
        new Promise<typeof okResult>((resolve) => {
          started++;
          notify();
          gates.push(() => resolve(okResult));
        }),
      render: async () => ({ ok: true, diagnostics: [], pages: [], durationMs: 0 }),
      export: async () => ({ ok: true, diagnostics: [], pdf: null }),
    };
    const waitForStarted = (n: number) =>
      new Promise<void>((res) => {
        const check = () => (started >= n ? res() : waiters.push(check));
        check();
      });
    const releaseAll = () => {
      for (const g of gates.splice(0)) g();
    };
    return { backend, waitForStarted, releaseAll };
  }

  const post = (app: ReturnType<typeof createCompileApp>) =>
    app.request("/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "check", input: "x" }),
    });

  it("503s with Retry-After once the in-flight cap is reached", async () => {
    const { backend, waitForStarted, releaseAll } = gatedBackend();
    const app = createCompileApp({ backend, maxConcurrentCompiles: 2 });

    const a = post(app); // fills slot 1 (blocks in backend)
    const b = post(app); // fills slot 2
    await waitForStarted(2);

    const shed = await post(app); // over the cap → shed immediately
    expect(shed.status).toBe(503);
    expect(shed.headers.get("retry-after")).toBeTruthy();

    releaseAll();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });

  it("frees the slot after a compile finishes", async () => {
    const { backend, waitForStarted, releaseAll } = gatedBackend();
    const app = createCompileApp({ backend, maxConcurrentCompiles: 1 });

    const first = post(app);
    await waitForStarted(1);
    expect((await post(app)).status).toBe(503); // full

    releaseAll(); // first completes, freeing the only slot
    expect((await first).status).toBe(200);

    const next = post(app); // slot is free again
    await waitForStarted(2); // backend.check entered for `next`
    releaseAll();
    expect((await next).status).toBe(200);
  });

  it("does not reject normal sequential traffic under the default cap", async () => {
    const okBackend = {
      check: async () => okResult,
      render: async () => ({ ok: true, diagnostics: [], pages: [], durationMs: 0 }),
      export: async () => ({ ok: true, diagnostics: [], pdf: null }),
    };
    const app = createCompileApp({ backend: okBackend });
    for (let k = 0; k < 10; k++) {
      expect((await post(app)).status).toBe(200);
    }
  });
});

describe("parseMaxConcurrentCompiles (GALLEY_COMPILE_MAX_CONCURRENCY)", () => {
  it("returns undefined when unset/blank (caller uses the default)", () => {
    expect(parseMaxConcurrentCompiles(undefined)).toBeUndefined();
    expect(parseMaxConcurrentCompiles("")).toBeUndefined();
    expect(parseMaxConcurrentCompiles("  ")).toBeUndefined();
  });

  it("parses a clean positive integer", () => {
    expect(parseMaxConcurrentCompiles("1")).toBe(1);
    expect(parseMaxConcurrentCompiles(" 8 ")).toBe(8);
  });

  it("throws on a non-positive or non-integer value (fails loud at startup)", () => {
    for (const bad of ["0", "-1", "four", "2.5", "4s", "1e3", "0x4"]) {
      expect(() => parseMaxConcurrentCompiles(bad)).toThrow(/positive integer/);
    }
  });
});

describe("apps/compile /readyz readiness (L7-OPS4)", () => {
  const okResult = { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };
  const fakeBackend = (check: () => Promise<typeof okResult>) => ({
    check,
    render: async () => ({ ok: true, diagnostics: [], pages: [], durationMs: 0 }),
    export: async () => ({ ok: true, diagnostics: [], pdf: null }),
  });

  it("reports ready (200) when no probe is wired — contract-preserving default", async () => {
    const app = createCompileApp({ backend: fakeBackend(async () => okResult) });
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  it("reflects the injected probe: 200 when ready, 503 when not", async () => {
    const ready = createCompileApp({ backend: fakeBackend(async () => okResult), checkReadiness: async () => true });
    expect((await ready.request("/readyz")).status).toBe(200);

    const notReady = createCompileApp({ backend: fakeBackend(async () => okResult), checkReadiness: async () => false });
    const res = await notReady.request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false });
  });

  it("healthz stays liveness-only (200) regardless of backend health", async () => {
    // A backend whose every compile faults still reports LIVE on /healthz — the
    // process is up. (This is the invariant the reverted 'deepen /healthz' attempt
    // broke; readiness now lives on /readyz instead.)
    const app = createCompileApp({
      backend: fakeBackend(async () => {
        throw new CompileUnavailableError("worker terminated", "timeout");
      }),
      checkReadiness: async () => false,
    });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(503);
  });
});

describe("createCachedReadiness — synthetic probe (L7-OPS4)", () => {
  const okResult = { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };

  it("probes with a fixed empty source (never user input) and caches within the TTL", async () => {
    const calls: unknown[] = [];
    const backend = {
      check: async (input: unknown) => {
        calls.push(input);
        return okResult;
      },
      render: async () => {
        throw new Error("render must not be used by the readiness probe");
      },
      export: async () => {
        throw new Error("export must not be used by the readiness probe");
      },
    };
    const ready = createCachedReadiness(backend, { ttlMs: 10_000, timeoutMs: 1_000 });

    expect(await ready()).toBe(true);
    expect(await ready()).toBe(true); // cached → no second probe
    expect(calls).toEqual([""]); // exactly one synthetic probe, with the empty source
  });

  const unusedOp = async (): Promise<never> => {
    throw new Error("only check() may be used by the readiness probe");
  };

  it("reports not-ready when the backend probe rejects (e.g. a faulted/killed worker)", async () => {
    const backend = {
      check: async () => {
        throw new CompileUnavailableError("compile worker faulted", "fault");
      },
      render: unusedOp,
      export: unusedOp,
    };
    const ready = createCachedReadiness(backend, { ttlMs: 10_000, timeoutMs: 1_000 });
    expect(await ready()).toBe(false);
  });

  it("reports not-ready when the probe exceeds its timeout (a wedged backend)", async () => {
    const backend = {
      check: () => new Promise<typeof okResult>(() => {}), // never resolves
      render: unusedOp,
      export: unusedOp,
    };
    const ready = createCachedReadiness(backend, { ttlMs: 10_000, timeoutMs: 20 });
    expect(await ready()).toBe(false);
  });

  it("coalesces concurrent callers onto a single in-flight probe", async () => {
    let calls = 0;
    let resolve!: (v: typeof okResult) => void;
    const backend = {
      check: () => {
        calls += 1;
        return new Promise<typeof okResult>((r) => {
          resolve = r;
        });
      },
      render: unusedOp,
      export: unusedOp,
    };
    const ready = createCachedReadiness(backend, { ttlMs: 10_000, timeoutMs: 1_000 });
    const a = ready();
    const b = ready();
    resolve(okResult);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(calls).toBe(1); // both callers shared one probe
  });
});

describe("apps/compile CORS allowlist (#22.2)", () => {
  // The allowlist is exact-match; a disallowed Origin must NOT be echoed back in
  // Access-Control-Allow-Origin (no opportunistic credentialed cross-origin read).
  const okResult = { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };
  const fakeBackend = {
    check: async () => okResult,
    render: async () => ({ ok: true, diagnostics: [], pages: [], durationMs: 0 }),
    export: async () => ({ ok: true, diagnostics: [], pdf: null }),
  };
  const app = createCompileApp({ backend: fakeBackend, allowedOrigins: ["https://app.galley.dev"] });

  const preflight = (origin: string) =>
    app.request("/compile", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });

  it("echoes the allowed origin on a preflight", async () => {
    const res = await preflight("https://app.galley.dev");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.galley.dev");
  });

  it("does NOT grant a disallowed origin (no Access-Control-Allow-Origin)", async () => {
    for (const origin of ["https://evil.example.com", "http://app.galley.dev", "https://app.galley.dev.evil.com", "null"]) {
      const res = await preflight(origin);
      expect(res.headers.get("access-control-allow-origin")).not.toBe(origin);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("grants no cross-origin access when the allowlist is empty (default same-origin)", async () => {
    const closed = createCompileApp({ backend: fakeBackend });
    const res = await closed.request("/compile", {
      method: "OPTIONS",
      headers: { origin: "https://app.galley.dev", "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
