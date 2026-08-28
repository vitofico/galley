/**
 * ADR-0019 security-review regressions for the hardened browser git HTTP wrapper:
 *  - HIGH-3: an oversized response is rejected BEFORE objects land — both the
 *    declared-Content-Length fast path and the streaming (chunked / lying-length)
 *    path abort once cumulative bytes exceed the inbound cap.
 *  - REC-5: the wrapper forbids redirects (`redirect: "error"`), so a remote can't
 *    cross-origin hop or https→http downgrade.
 *
 * Driven with a stub `global.fetch`; no network. Node's global `fetch` /
 * `ReadableStream` are present in the gate's Node env.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createBrowserGitHttp,
  InboundCapError,
  MAX_INBOUND_RESPONSE_BYTES,
} from "./browser-git-http.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A Response whose body streams `chunkCount` chunks of `chunkBytes` each. */
function streamingResponse(chunkBytes: number, chunkCount: number, headers: Record<string, string> = {}) {
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return new Response(stream, { status: 200, headers });
}

/** Drain the GitHttpResponse body iterator (what isomorphic-git does). */
async function drain(body: unknown): Promise<number> {
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) total += chunk.byteLength;
  return total;
}

describe("hardened browser git HTTP — inbound cap (HIGH-3)", () => {
  it("aborts immediately when Content-Length declares an oversized response", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamingResponse(1024, 1, { "content-length": String(MAX_INBOUND_RESPONSE_BYTES + 1) }),
    ) as unknown as typeof fetch;
    const http = createBrowserGitHttp();
    await expect(http.request({ url: "https://h/info/refs", method: "GET" })).rejects.toBeInstanceOf(
      InboundCapError,
    );
  });

  it("aborts mid-stream when cumulative bytes exceed the cap (chunked / no length)", async () => {
    // Chunks that sum to just over the cap, with NO content-length header.
    const chunk = 8 * 1024 * 1024; // 8 MiB
    const count = Math.ceil(MAX_INBOUND_RESPONSE_BYTES / chunk) + 1;
    globalThis.fetch = vi.fn(async () => streamingResponse(chunk, count)) as unknown as typeof fetch;
    const http = createBrowserGitHttp();
    const res = (await http.request({ url: "https://h/git-upload-pack", method: "POST" })) as {
      body: unknown;
    };
    await expect(drain(res.body)).rejects.toBeInstanceOf(InboundCapError);
  });

  it("passes a within-cap response through unchanged", async () => {
    globalThis.fetch = vi.fn(async () => streamingResponse(1024, 4)) as unknown as typeof fetch;
    const http = createBrowserGitHttp();
    const res = (await http.request({ url: "https://h/info/refs", method: "GET" })) as {
      statusCode: number;
      body: unknown;
    };
    expect(res.statusCode).toBe(200);
    expect(await drain(res.body)).toBe(4096);
  });
});

describe("hardened browser git HTTP — no redirects (REC-5)", () => {
  it("passes redirect:'error' to fetch so a redirect cannot be followed", async () => {
    const spy = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(streamingResponse(16, 1)));
    globalThis.fetch = spy as unknown as typeof fetch;
    const http = createBrowserGitHttp();
    await http.request({ url: "https://h/info/refs", method: "GET" });
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]![1];
    expect(init?.redirect).toBe("error");
  });

  it("surfaces fetch's redirect rejection (a 30x with redirect:'error' throws)", async () => {
    // fetch() rejects when a redirect is encountered under redirect:'error'.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch: redirect not allowed");
    }) as unknown as typeof fetch;
    const http = createBrowserGitHttp();
    await expect(http.request({ url: "https://h/info/refs", method: "GET" })).rejects.toThrow(
      /redirect/i,
    );
  });
});
