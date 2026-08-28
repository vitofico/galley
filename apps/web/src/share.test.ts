import { describe, it, expect } from "vitest";
import {
  resolveSyncUrl,
  runtimeSyncUrl,
  configuredSyncUrlOverride,
  mintShareRoom,
  buildShareLink,
  parseShareRole,
  resolveSessionRole,
  DEFAULT_SHARE_ROLE,
  SYNC_PORT,
} from "./share.js";

describe("resolveSyncUrl", () => {
  it("derives ws://host:1234 from a plain http page", () => {
    expect(resolveSyncUrl(undefined, { protocol: "http:", hostname: "localhost" })).toBe(
      `ws://localhost:${SYNC_PORT}`,
    );
  });

  it("uses wss on a secure page (no mixed-content block)", () => {
    expect(resolveSyncUrl(undefined, { protocol: "https:", hostname: "galley.example" })).toBe(
      `wss://galley.example:${SYNC_PORT}`,
    );
  });

  it("brackets an IPv6 host", () => {
    expect(resolveSyncUrl(undefined, { protocol: "http:", hostname: "::1" })).toBe(
      `ws://[::1]:${SYNC_PORT}`,
    );
  });

  it("honors a trimmed override and strips trailing slashes", () => {
    expect(
      resolveSyncUrl("  ws://relay.internal:9000/  ", { protocol: "http:", hostname: "ignored" }),
    ).toBe("ws://relay.internal:9000");
  });

  it("ignores a blank override and falls back to the origin", () => {
    expect(resolveSyncUrl("   ", { protocol: "http:", hostname: "localhost" })).toBe(
      `ws://localhost:${SYNC_PORT}`,
    );
  });
});

describe("runtimeSyncUrl (serve-time /config.js)", () => {
  it("reads a non-empty syncUrl string out of the config global", () => {
    expect(runtimeSyncUrl({ syncUrl: "wss://galley.example/sync" })).toBe(
      "wss://galley.example/sync",
    );
  });

  it("treats absent / non-string / empty as null (read defensively)", () => {
    expect(runtimeSyncUrl(undefined)).toBeNull();
    expect(runtimeSyncUrl(null)).toBeNull();
    expect(runtimeSyncUrl({})).toBeNull();
    expect(runtimeSyncUrl({ syncUrl: "" })).toBeNull();
    expect(runtimeSyncUrl({ syncUrl: "   " })).toBeNull();
    expect(runtimeSyncUrl({ syncUrl: 42 })).toBeNull();
    expect(runtimeSyncUrl("nope")).toBeNull();
  });
});

describe("configuredSyncUrlOverride (runtime config > build env > derive)", () => {
  // No __GALLEY_CONFIG__ in the Node gate, so runtimeSyncUrl() reads null and the
  // injected build-env arg drives the result.
  it("falls back to the build-time env when no runtime config is present", () => {
    expect(configuredSyncUrlOverride("wss://from-build-env/sync")).toBe("wss://from-build-env/sync");
  });

  it("is undefined when neither runtime config nor build env is set (→ derive)", () => {
    expect(configuredSyncUrlOverride(undefined)).toBeUndefined();
  });
});

describe("mintShareRoom", () => {
  it("is prefixed and unguessably long, and never repeats", () => {
    const a = mintShareRoom();
    const b = mintShareRoom();
    expect(a.startsWith("share-")).toBe(true);
    expect(a.length).toBeGreaterThan("share-".length + 16);
    expect(a).not.toEqual(b);
  });
});

describe("buildShareLink", () => {
  it("targets the clean /join/<room> path (#19.4) with no query params by default", () => {
    const link = buildShareLink("share-abc");
    const url = new URL(link, "http://x");
    expect(url.pathname).toBe("/join/share-abc");
    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it("carries an explicit non-default sync override as ?sync=", () => {
    const link = buildShareLink("share-abc", "wss://relay.example:9000");
    const url = new URL(link, "http://x");
    expect(url.pathname).toBe("/join/share-abc");
    expect(url.searchParams.get("sync")).toBe("wss://relay.example:9000");
  });

  it("url-encodes the room segment", () => {
    const link = buildShareLink("share x/y");
    expect(link).toBe("/join/share%20x%2Fy");
    const url = new URL(link, "http://x");
    expect(decodeURIComponent(url.pathname.split("/").pop()!)).toBe("share x/y");
  });

  it("encodes a viewer role as ?role=viewer (B19-sharing-roles)", () => {
    const url = new URL(buildShareLink("share-abc", undefined, "viewer"), "http://x");
    expect(url.pathname).toBe("/join/share-abc");
    expect(url.searchParams.get("role")).toBe("viewer");
  });

  it("encodes the editor role EXPLICITLY as ?role=editor (SEC fail-closed)", () => {
    // The join parser fails closed to `viewer` on an absent role, so an editor
    // invite MUST carry `role=editor` or it would be (correctly) downgraded.
    const url = new URL(buildShareLink("share-abc", undefined, "editor"), "http://x");
    expect(url.pathname).toBe("/join/share-abc");
    expect(url.searchParams.get("role")).toBe("editor");
  });

  it("omits role entirely when none is passed (legacy everyone-edits share)", () => {
    // A caller passing no role mints a link with no `?role=` — which, by the
    // fail-closed parser, joins as a VIEWER. Hosts pass an explicit role.
    expect(buildShareLink("share-abc")).toBe("/join/share-abc");
    expect([...new URL(buildShareLink("share-abc"), "http://x").searchParams.keys()]).toEqual([]);
  });

  it("carries both a sync override and a viewer role", () => {
    const url = new URL(
      buildShareLink("share-abc", "wss://relay.example:9000", "viewer"),
      "http://x",
    );
    expect(url.searchParams.get("sync")).toBe("wss://relay.example:9000");
    expect(url.searchParams.get("role")).toBe("viewer");
  });
});

describe("parseShareRole (B19-sharing-roles — fail closed for URL-supplied roles)", () => {
  it("decodes an explicit viewer role", () => {
    expect(parseShareRole("viewer")).toBe("viewer");
  });

  it("decodes an explicit editor role (the ONLY way a URL grants edit)", () => {
    expect(parseShareRole("editor")).toBe("editor");
  });

  it("FAILS CLOSED to viewer for an absent/empty/unknown/forged role (privilege-escalation fix)", () => {
    // SEC: a join link may only ever GRANT edit by EXPLICITLY saying so. An
    // absent role, an empty one, `owner`, or any forged value resolves to the
    // least-privilege `viewer` — never the editor default (which is reserved for
    // the LOCAL owner, who does not route through this parser).
    expect(parseShareRole(null)).toBe("viewer");
    expect(parseShareRole(undefined)).toBe("viewer");
    expect(parseShareRole("")).toBe("viewer");
    expect(parseShareRole("owner")).toBe("viewer");
    expect(parseShareRole("admin")).toBe("viewer");
    expect(parseShareRole("Editor")).toBe("viewer"); // case-sensitive: not the literal
    expect(parseShareRole("VIEWER")).toBe("viewer");
  });

  it("keeps the LOCAL-owner default an editor (never downgraded by the URL parser)", () => {
    // The owner default is a separate constant the owner/host paths read directly.
    expect(DEFAULT_SHARE_ROLE).toBe("editor");
  });
});

describe("resolveSessionRole (B19 — the CONNECTION is the source of truth for the role)", () => {
  it("a solo/local session (no connection) is always the owner-editor", () => {
    expect(resolveSessionRole(false, undefined, undefined)).toBe("editor");
    // Even a stray ?role=viewer on the owner's own /p/<id> URL must not downgrade
    // a session with no live connection (the owner is local, not a joiner).
    expect(resolveSessionRole(false, undefined, "viewer")).toBe("editor");
  });

  it("BUG-2: the OWNER stays an editor right after Share (connection established as editor)", () => {
    // The host's live Share upgrade connects as `editor`. Before the fix, merely
    // having a connection made the memo fall through to the fail-closed `?role=`
    // parse (the owner's URL has none) → read-only. The connection's role wins.
    expect(resolveSessionRole(true, "editor", undefined)).toBe("editor");
    // …and an irrelevant ?role= on the owner's URL never overrides the connection.
    expect(resolveSessionRole(true, "editor", "viewer")).toBe("editor");
  });

  it("a genuine viewer-link joiner stays read-only (no regression)", () => {
    // The joiner's connection was established with their link's decoded `viewer`.
    expect(resolveSessionRole(true, "viewer", "viewer")).toBe("viewer");
  });

  it("an editor-link joiner keeps edit rights", () => {
    expect(resolveSessionRole(true, "editor", "editor")).toBe("editor");
  });

  it("a connection with NO recorded role falls back to the fail-closed URL parse", () => {
    // Legacy/path-based joins that never recorded a role on the connection still
    // honor the least-privilege `?role=` decode (viewer when absent/forged).
    expect(resolveSessionRole(true, undefined, "viewer")).toBe("viewer");
    expect(resolveSessionRole(true, undefined, "editor")).toBe("editor");
    expect(resolveSessionRole(true, undefined, undefined)).toBe("viewer");
  });
});
