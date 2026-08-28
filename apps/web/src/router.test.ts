import { describe, it, expect } from "vitest";
import { homeShowsEditor, parseRoute, routeHref } from "./router.js";

describe("parseRoute", () => {
  it("maps / to the default project", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
  });

  it("maps /library (with or without a trailing slash)", () => {
    expect(parseRoute("/library")).toEqual({ kind: "library" });
    expect(parseRoute("/library/")).toEqual({ kind: "library" });
  });

  it("maps /settings (with or without a trailing slash) — #19.7", () => {
    expect(parseRoute("/settings")).toEqual({ kind: "settings" });
    expect(parseRoute("/settings/")).toEqual({ kind: "settings" });
  });

  it("maps /p/<id> with the id decoded", () => {
    expect(parseRoute("/p/proj-abc")).toEqual({ kind: "project", id: "proj-abc" });
    expect(parseRoute("/p/a%20b")).toEqual({ kind: "project", id: "a b" });
  });

  it("maps /join/<room> and picks up the ?sync= override", () => {
    expect(parseRoute("/join/share-xyz")).toEqual({ kind: "join", room: "share-xyz" });
    expect(parseRoute("/join/share-xyz", "?sync=ws%3A%2F%2Frelay%3A9000")).toEqual({
      kind: "join",
      room: "share-xyz",
      sync: "ws://relay:9000",
    });
  });

  it("carries an explicit join role into the route, fail-closed", () => {
    expect(parseRoute("/join/share-xyz", "?role=viewer")).toEqual({
      kind: "join",
      room: "share-xyz",
      role: "viewer",
    });
    expect(parseRoute("/join/share-xyz", "?sync=ws%3A%2F%2Frelay%3A9000&role=editor")).toEqual({
      kind: "join",
      room: "share-xyz",
      sync: "ws://relay:9000",
      role: "editor",
    });
    // Forged/unknown roles decode to the least privilege, never escalate.
    expect(parseRoute("/join/share-xyz", "?role=owner")).toEqual({
      kind: "join",
      room: "share-xyz",
      role: "viewer",
    });
    // Absent role stays absent (legacy links unchanged).
    expect(parseRoute("/join/share-xyz")).toEqual({ kind: "join", room: "share-xyz" });
  });

  it("survives a malformed percent-encoding by using the raw segment", () => {
    expect(parseRoute("/p/%E0%A4%A")).toEqual({ kind: "project", id: "%E0%A4%A" });
  });

  it("falls back to the default project on unknown paths", () => {
    expect(parseRoute("/nope")).toEqual({ kind: "home" });
    expect(parseRoute("/p")).toEqual({ kind: "home" });
    expect(parseRoute("/p/x/y")).toEqual({ kind: "home" });
    expect(parseRoute("/join")).toEqual({ kind: "home" });
    expect(parseRoute("/settings/x")).toEqual({ kind: "home" });
  });
});

describe("homeShowsEditor", () => {
  // Bare `/` (and `/` with non-seed query) lands on the Projects page — the new
  // home surface. Only the Einstein showcase/e2e hatch (`?seed=…`) keeps booting
  // the editor on home, so its 46 existing usages are unchanged.
  it("is false for a bare home (Projects page)", () => {
    expect(homeShowsEditor("")).toBe(false);
    expect(homeShowsEditor("?")).toBe(false);
  });

  it("is true only when a seed is requested", () => {
    expect(homeShowsEditor("?seed=einstein")).toBe(true);
    expect(homeShowsEditor("?seed=blank")).toBe(true);
    expect(homeShowsEditor("?foo=1&seed=einstein")).toBe(true);
  });

  it("is false for unrelated query params", () => {
    expect(homeShowsEditor("?serverCompile=1&compileUrl=http://x/compile")).toBe(false);
    expect(homeShowsEditor("?id=proj-1")).toBe(false);
  });
});

describe("routeHref", () => {
  it("round-trips every route kind through parseRoute", () => {
    const routes = [
      { kind: "home" },
      { kind: "library" },
      { kind: "project", id: "proj-1" },
      { kind: "join", room: "share-abc" },
      { kind: "join", room: "share-abc", sync: "ws://relay:9000" },
      { kind: "join", room: "share-abc", role: "viewer" },
      { kind: "join", room: "share-abc", sync: "ws://relay:9000", role: "editor" },
      { kind: "settings" },
    ] as const;
    for (const route of routes) {
      const href = routeHref(route);
      const url = new URL(href, "http://x");
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
  });

  it("percent-encodes ids and rooms", () => {
    expect(routeHref({ kind: "project", id: "a b" })).toBe("/p/a%20b");
    expect(routeHref({ kind: "join", room: "r/s" })).toBe("/join/r%2Fs");
  });
});
