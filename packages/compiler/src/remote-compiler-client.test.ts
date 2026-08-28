/**
 * Roadmap #3 slice 2: the remote compiler seam. Offline — a fake `fetch` stands
 * in for `apps/compile`, so the request shape, PDF base64 decode, error mapping,
 * cancellation, and timeout are all unit-tested with no real server.
 */
import { describe, it, expect, vi } from "vitest";
import type { CheckResult, CompileServiceRequest, ExportResultWire } from "@galley/shared";
import { RemoteCompilerClient } from "./remote-compiler-client.js";
import { CompileCancelledError, CompileTimeoutError } from "./compiler-client.js";
import { bytesToBase64, base64ToBytes } from "./base64.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const URL = "http://compile.test/compile";

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes, including a chunk boundary", () => {
    for (const len of [0, 1, 2, 3, 255, 0x8000, 0x8001, 0x8000 * 2 + 5]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31 + 7) & 0xff;
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });
});

describe("RemoteCompilerClient", () => {
  it("POSTs {op,input} as JSON and returns the parsed check result", async () => {
    const want: CheckResult = { ok: true, diagnostics: [], pageCount: 2, durationMs: 5 };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(want));
    const client = new RemoteCompilerClient({ url: URL, fetch: fetchMock as unknown as typeof fetch });

    const got = await client.check("= Hi");
    expect(got).toEqual(want);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(URL);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as CompileServiceRequest;
    expect(body).toEqual({ op: "check", input: "= Hi" });
  });

  it("sends a ProjectInput unchanged through the wire", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ ok: true, diagnostics: [], pageCount: 1, durationMs: 1 }),
    );
    const client = new RemoteCompilerClient({ url: URL, fetch: fetchMock as unknown as typeof fetch });
    const input = { kind: "project" as const, main: "/main.typ", files: [{ path: "/main.typ", text: "x" }] };
    await client.check(input);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as CompileServiceRequest;
    expect(body).toEqual({ op: "check", input });
  });

  it("decodes the base64 PDF from an export result", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]); // "%PDF-" + bytes
    const wire: ExportResultWire = { ok: true, diagnostics: [], pdfBase64: bytesToBase64(pdfBytes) };
    const client = new RemoteCompilerClient({
      url: URL,
      fetch: (async () => jsonResponse(wire)) as unknown as typeof fetch,
    });
    const res = await client.export("doc");
    expect(res.ok).toBe(true);
    expect(res.pdf).toEqual(pdfBytes);
  });

  it("returns a null pdf when export failed", async () => {
    const wire: ExportResultWire = { ok: false, diagnostics: [], pdfBase64: null };
    const client = new RemoteCompilerClient({
      url: URL,
      fetch: (async () => jsonResponse(wire)) as unknown as typeof fetch,
    });
    const res = await client.export("bad");
    expect(res.ok).toBe(false);
    expect(res.pdf).toBeNull();
  });

  it("rejects on a non-2xx response", async () => {
    const client = new RemoteCompilerClient({
      url: URL,
      fetch: (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch,
    });
    await expect(client.check("x")).rejects.toThrow(/500/);
  });

  it("cancel() aborts the in-flight request with CompileCancelledError", async () => {
    // A fetch that only settles when its abort signal fires.
    const abortableFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }
      });
    const client = new RemoteCompilerClient({
      url: URL,
      fetch: abortableFetch as unknown as typeof fetch,
      timeoutMs: 0,
    });
    const pending = client.check("x");
    client.cancel();
    await expect(pending).rejects.toBeInstanceOf(CompileCancelledError);
  });

  it("rejects with CompileTimeoutError when the request exceeds the timeout", async () => {
    const neverFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const client = new RemoteCompilerClient({
      url: URL,
      fetch: neverFetch as unknown as typeof fetch,
      timeoutMs: 10,
    });
    await expect(client.check("x")).rejects.toBeInstanceOf(CompileTimeoutError);
  });
});
