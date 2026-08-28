import { describe, expect, it } from "vitest";
import {
  createHttpCompileService,
  type FetchLike,
  type ResponseLike,
} from "./compile-client.js";

/** A minimal OK response carrying `body` as JSON text (no stream). */
function jsonResponse(body: unknown, status = 200): ResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

const CHECK_OK = { ok: true, diagnostics: [], pageCount: 1, durationMs: 2 };

describe("compile client — hardened loopback transport (finding 2)", () => {
  it("POSTs the check op with redirect:'error' and an abort signal (never follows a redirect)", async () => {
    const seen: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(CHECK_OK);
    };
    const service = createHttpCompileService("http://localhost:3001", fetchImpl);

    const result = await service.check("= hi\n");
    expect(result).toEqual(CHECK_OK);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://localhost:3001/compile");
    expect(seen[0]!.init.redirect).toBe("error"); // a 307/308 must never replay the body
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(seen[0]!.init.body)).toEqual({ op: "check", input: "= hi\n" });
  });

  it("aborts after the configured timeout and reports it honestly", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
      });
    const service = createHttpCompileService("http://localhost:3001", fetchImpl, {
      timeoutMs: 20,
    });
    await expect(service.check("x")).rejects.toThrow(/timed out after 20ms/);
  });

  it("caps the response size before parsing (buffered text fallback)", async () => {
    const huge = `{"pad":"${"x".repeat(5 * 1024 * 1024)}"}`;
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => huge,
    });
    const service = createHttpCompileService("http://localhost:3001", fetchImpl);
    await expect(service.check("x")).rejects.toThrow(/response exceeds/);
  });

  it("caps the response size mid-STREAM without buffering the whole body", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB per pull, endless
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            pulls += 1;
            return { done: false, value: chunk };
          },
        }),
      },
      text: async () => "",
    });
    const service = createHttpCompileService("http://localhost:3001", fetchImpl);
    await expect(service.check("x")).rejects.toThrow(/response exceeds/);
    expect(pulls).toBeLessThanOrEqual(5); // stopped at the 4 MiB cap, not later
  });

  it("surfaces a non-OK status with the service's small error reason", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "compile unavailable" }, 503);
    const service = createHttpCompileService("http://localhost:3001", fetchImpl);
    await expect(service.check("x")).rejects.toThrow(
      /compile service responded 503: compile unavailable/,
    );
  });

  it("rejects an unexpected response shape instead of fabricating diagnostics", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ nope: true });
    const service = createHttpCompileService("http://localhost:3001", fetchImpl);
    await expect(service.check("x")).rejects.toThrow(/unexpected response shape/);
  });

  it("threads through a well-formed artifact descriptor (D3)", async () => {
    const artifact = { bytes: 1234, hash: "a".repeat(64), mime: "application/x-typst-vector" };
    const fetchImpl: FetchLike = async () => jsonResponse({ ...CHECK_OK, artifact });
    const service = createHttpCompileService("http://localhost:3001", fetchImpl);
    const result = await service.check("= hi\n");
    expect(result.artifact).toEqual(artifact);
  });

  it("preserves an artifact without a mime (D3)", async () => {
    const artifact = { bytes: 7, hash: "b".repeat(64) };
    const fetchImpl: FetchLike = async () => jsonResponse({ ...CHECK_OK, artifact });
    const service = createHttpCompileService("http://localhost:3001", fetchImpl);
    const result = await service.check("x");
    expect(result.artifact).toEqual(artifact);
    expect("mime" in result.artifact!).toBe(false);
  });

  it("omits the artifact when the service sends none, and drops a malformed one (D3)", async () => {
    const none: FetchLike = async () => jsonResponse(CHECK_OK);
    expect((await createHttpCompileService("http://x", none).check("x")).artifact).toBeUndefined();

    const junk: FetchLike = async () =>
      jsonResponse({ ...CHECK_OK, artifact: { bytes: "big", hash: 5 } });
    expect(
      (await createHttpCompileService("http://x", junk).check("x")).artifact,
    ).toBeUndefined();
  });

  it("drops a malformed artifact (fractional bytes / bad hash) but keeps the result (hardening)", async () => {
    // The rest of the check result must survive — only the bad descriptor drops.
    const drop = async (artifact: unknown): Promise<void> => {
      const fetchImpl: FetchLike = async () => jsonResponse({ ...CHECK_OK, artifact });
      const result = await createHttpCompileService("http://x", fetchImpl).check("x");
      expect(result.ok).toBe(true); // result preserved
      expect(result.pageCount).toBe(1);
      expect(result.artifact).toBeUndefined(); // descriptor dropped
    };

    await drop({ bytes: 12.5, hash: "a".repeat(64) }); // fractional bytes
    await drop({ bytes: -1, hash: "a".repeat(64) }); // negative bytes
    await drop({ bytes: 10, hash: "a".repeat(63) }); // too-short hash
    await drop({ bytes: 10, hash: "a".repeat(65) }); // too-long hash
    await drop({ bytes: 10, hash: "A".repeat(64) }); // uppercase hex
    await drop({ bytes: 10, hash: `g${"a".repeat(63)}` }); // non-hex char
  });

  it("accepts a well-formed 64-char lowercase sha256 hash (hardening)", async () => {
    const artifact = { bytes: 0, hash: "0123456789abcdef".repeat(4) }; // 64 hex, bytes=0 ok
    const fetchImpl: FetchLike = async () => jsonResponse({ ...CHECK_OK, artifact });
    const result = await createHttpCompileService("http://x", fetchImpl).check("x");
    expect(result.artifact).toEqual(artifact);
  });
});
