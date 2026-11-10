import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSiteUrl, syncUrlFromRuntimeConfig } from "./site-config.js";

const served = (body: string, status = 200) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));

describe("resolveSiteUrl", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves argv alone when no --url is given", async () => {
    const fetchImpl = served("");
    expect(await resolveSiteUrl(["--sync", "ws://localhost:1234"], {}, fetchImpl)).toEqual([
      "--sync",
      "ws://localhost:1234",
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replaces --url with the relay the site's /config.js declares", async () => {
    const fetchImpl = served(
      'window.__GALLEY_CONFIG__ = {"compileUrl":"https://g.example/compile","syncUrl":"wss://g.example/sync","auth":true};\n',
    );
    const argv = await resolveSiteUrl(["--url", "https://g.example", "--pairing-code", "c"], {}, fetchImpl);
    expect(argv).toEqual(["--pairing-code", "c", "--sync=wss://g.example/sync"]);
    expect(fetchImpl).toHaveBeenCalledWith("https://g.example/config.js", expect.anything());
  });

  it("reads the site from GALLEY_MCP_URL and accepts --url=value", async () => {
    const fetchImpl = served('window.__GALLEY_CONFIG__ = {"syncUrl":"wss://g.example/sync"};');
    expect(await resolveSiteUrl([], { GALLEY_MCP_URL: "https://g.example" }, fetchImpl)).toEqual([
      "--sync=wss://g.example/sync",
    ]);
    expect(await resolveSiteUrl(["--url=https://g.example"], {}, fetchImpl)).toEqual([
      "--sync=wss://g.example/sync",
    ]);
  });

  it("falls back to the co-located default port when the site declares no relay", async () => {
    expect(await resolveSiteUrl(["--url", "http://localhost:5173"], {}, served("", 404))).toEqual([
      "--sync=ws://localhost:1234",
    ]);
    expect(
      await resolveSiteUrl(
        ["--url", "https://g.example"],
        {},
        served('window.__GALLEY_CONFIG__ = {"auth":true};'),
      ),
    ).toEqual(["--sync=wss://g.example:1234"]);
  });

  it("refuses --url together with --sync", async () => {
    await expect(
      resolveSiteUrl(["--url", "https://g.example", "--sync", "ws://x"], {}, served("")),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      resolveSiteUrl(["--url", "https://g.example"], { GALLEY_MCP_SYNC: "ws://x" }, served("")),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("refuses a malformed site, credentials, and a cleartext downgrade", async () => {
    await expect(resolveSiteUrl(["--url", "g.example"], {}, served(""))).rejects.toThrow(/valid URL/);
    await expect(resolveSiteUrl(["--url", "ftp://g.example"], {}, served(""))).rejects.toThrow(
      /http:\/\/ or https:\/\//,
    );
    await expect(
      resolveSiteUrl(["--url", "https://u:p@g.example"], {}, served("")),
    ).rejects.toThrow(/credentials/);
    await expect(
      resolveSiteUrl(
        ["--url", "https://g.example"],
        {},
        served('window.__GALLEY_CONFIG__ = {"syncUrl":"ws://g.example/sync"};'),
      ),
    ).rejects.toThrow(/downgrade/);
    await expect(
      resolveSiteUrl(
        ["--url", "https://g.example"],
        {},
        served('window.__GALLEY_CONFIG__ = {"syncUrl":"https://g.example/sync"};'),
      ),
    ).rejects.toThrow(/not ws:\/\/ or wss:\/\//);
  });

  it("reports an unreachable site with the --sync escape hatch", async () => {
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(resolveSiteUrl(["--url", "https://g.example"], {}, down)).rejects.toThrow(
      /could not read https:\/\/g\.example\/config\.js \(ECONNREFUSED\).*--sync/,
    );
    await expect(resolveSiteUrl(["--url", "https://g.example"], {}, served("", 500))).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("does not touch the network for --help", async () => {
    const fetchImpl = served("");
    expect(await resolveSiteUrl(["--url", "https://g.example", "--help"], {}, fetchImpl)).toEqual([
      "--url",
      "https://g.example",
      "--help",
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("syncUrlFromRuntimeConfig", () => {
  it("returns null for anything that is not the expected single assignment", () => {
    expect(syncUrlFromRuntimeConfig("")).toBeNull();
    expect(syncUrlFromRuntimeConfig("<!doctype html><html></html>")).toBeNull();
    expect(syncUrlFromRuntimeConfig("window.__GALLEY_CONFIG__ = {oops};")).toBeNull();
    expect(syncUrlFromRuntimeConfig('window.__GALLEY_CONFIG__ = {"syncUrl":42};')).toBeNull();
    expect(syncUrlFromRuntimeConfig('window.__GALLEY_CONFIG__ = {"syncUrl":"  "};')).toBeNull();
  });
});
