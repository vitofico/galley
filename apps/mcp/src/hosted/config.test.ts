import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECTOR_PORT, parseHostedConfig } from "./config.js";

const ok = {
  GALLEY_DATA_DIR: "/var/lib/galley/projects",
  GALLEY_CONNECTOR_SYNC_URL: "ws://galley-sync/",
};

describe("hosted connector config", () => {
  it("needs the data volume and the relay, and defaults the rest", () => {
    expect(parseHostedConfig(ok)).toEqual({
      port: DEFAULT_CONNECTOR_PORT,
      dataDir: "/var/lib/galley/projects",
      syncUrl: "ws://galley-sync", // trailing slash dropped: a room id is appended
    });
    expect(() => parseHostedConfig({ ...ok, GALLEY_DATA_DIR: " " })).toThrow(
      /GALLEY_DATA_DIR/,
    );
    expect(() =>
      parseHostedConfig({ GALLEY_DATA_DIR: ok.GALLEY_DATA_DIR }),
    ).toThrow(/GALLEY_CONNECTOR_SYNC_URL/);
  });

  it("takes an optional compile service and port", () => {
    expect(
      parseHostedConfig({
        ...ok,
        PORT: "9000",
        GALLEY_CONNECTOR_COMPILE_URL: "http://galley-compile:3001",
      }),
    ).toMatchObject({ port: 9000, compileUrl: "http://galley-compile:3001" });
  });

  it("refuses a URL of the wrong kind, with credentials, or with a query", () => {
    for (const GALLEY_CONNECTOR_SYNC_URL of [
      "galley-sync",
      "http://galley-sync",
      "ws://user:pw@galley-sync",
      "ws://galley-sync/?room=x",
    ])
      expect(() =>
        parseHostedConfig({ ...ok, GALLEY_CONNECTOR_SYNC_URL }),
      ).toThrow(/GALLEY_CONNECTOR_SYNC_URL/);
    expect(() =>
      parseHostedConfig({ ...ok, GALLEY_CONNECTOR_COMPILE_URL: "ws://x" }),
    ).toThrow(/GALLEY_CONNECTOR_COMPILE_URL/);
    for (const PORT of ["0", "70000", "http"])
      expect(() => parseHostedConfig({ ...ok, PORT })).toThrow(/PORT/);
  });
});
