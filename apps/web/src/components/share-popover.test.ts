import { describe, it, expect } from "vitest";
import {
  buildPresenceRoster,
  displayedShareLink,
  isShareConnecting,
  peerDisplayName,
  peerRoleLabel,
  presenceSummary,
} from "./share-popover.js";

const ORIGIN = "http://localhost:4173";

describe("isShareConnecting (H8)", () => {
  it("is true only while a connection exists but has never connected (linkStatus 'initial')", () => {
    expect(isShareConnecting(true, "initial")).toBe(true);
  });

  it("is false once the socket has connected at least once", () => {
    // After the first "connected", linkStatus leaves "initial" for good.
    expect(isShareConnecting(true, "online")).toBe(false);
    expect(isShareConnecting(true, "reconnecting")).toBe(false);
    expect(isShareConnecting(true, "reconnected")).toBe(false);
  });

  it("is false with no connection (a plain local session is never 'connecting')", () => {
    expect(isShareConnecting(false, "initial")).toBe(false);
    expect(isShareConnecting(false, "online")).toBe(false);
  });
});

describe("displayedShareLink", () => {
  it("resolves a minted relative link against the page origin", () => {
    expect(displayedShareLink("/?project=1&room=share-x", false, ORIGIN, `${ORIGIN}/`)).toBe(
      "http://localhost:4173/?project=1&room=share-x",
    );
  });

  it("keeps an already-absolute minted link", () => {
    expect(
      displayedShareLink("https://galley.example/?room=share-y", true, ORIGIN, `${ORIGIN}/`),
    ).toBe("https://galley.example/?room=share-y");
  });

  it("a connected joiner with no minted link shows their own page URL", () => {
    const href = `${ORIGIN}/?project=1&collab=1&room=share-abc`;
    expect(displayedShareLink(null, true, ORIGIN, href)).toBe(href);
  });

  it("not connected and nothing minted → null (explainer state)", () => {
    expect(displayedShareLink(null, false, ORIGIN, `${ORIGIN}/`)).toBeNull();
  });
});

describe("buildPresenceRoster (L7 '(you)' marker)", () => {
  const A = { author: { kind: "human" }, user: { name: "Ada" } };
  const B = { author: { kind: "human" }, user: { name: "Bobbie" } };

  it("marks the row whose clientID matches the local client as 'you'", () => {
    const roster = buildPresenceRoster([[1, A], [2, B]], 1);
    expect(roster.map((r) => r.isYou)).toEqual([true, false]);
    // Carries the clientID and preserves the presence fields + order.
    expect(roster[0]).toMatchObject({ clientID: 1, isYou: true, user: { name: "Ada" } });
    expect(roster[1]).toMatchObject({ clientID: 2, isYou: false, user: { name: "Bobbie" } });
  });

  it("marks exactly one row even when two peers look identical (two tabs)", () => {
    // Same user, two tabs → two distinct clientIDs → two rows; only the local one is 'you'.
    const roster = buildPresenceRoster([[7, A], [9, A]], 9);
    expect(roster.filter((r) => r.isYou)).toHaveLength(1);
    expect(roster.find((r) => r.isYou)?.clientID).toBe(9);
  });

  it("marks nothing when there is no local client id (no live awareness)", () => {
    const roster = buildPresenceRoster([[1, A], [2, B]], null);
    expect(roster.some((r) => r.isYou)).toBe(false);
  });
});

describe("presenceSummary", () => {
  it("keeps the topbar-era wording when every peer is an editor (e2e regexes match)", () => {
    expect(presenceSummary([{}, {}])).toBe("2 editor(s)");
    expect(presenceSummary([{}])).toBe("1 editor(s)");
  });
  it("counts viewers separately when present", () => {
    expect(presenceSummary([{}, { role: "viewer" }])).toBe("1 editor(s) · 1 viewer(s)");
    expect(presenceSummary([{ role: "viewer" }, { role: "viewer" }])).toBe("2 viewer(s)");
  });
});

describe("peerDisplayName (#19.4)", () => {
  it("prefers the presence user.name (the real display name)", () => {
    expect(
      peerDisplayName({
        author: { kind: "human", name: "ignored" },
        user: { name: "Bobbie" },
      }),
    ).toBe("Bobbie");
  });

  it("falls back to the author's name, then the generic labels", () => {
    expect(peerDisplayName({ author: { kind: "human", name: "Ada" } })).toBe("Ada");
    expect(peerDisplayName({ author: { kind: "human" } })).toBe("Editor");
    expect(peerDisplayName({ author: { kind: "agent" } })).toBe("Agent");
    expect(peerDisplayName({})).toBe("Editor");
  });

  it("treats blank names as absent", () => {
    expect(peerDisplayName({ author: { kind: "human" }, user: { name: "   " } })).toBe("Editor");
  });
});

describe("peerRoleLabel (B19-sharing-roles)", () => {
  it("badges a viewer peer", () => {
    expect(
      peerRoleLabel({ author: { kind: "human", name: "Ada" }, role: "viewer" }),
    ).toBe("Viewer");
  });

  it("shows no badge for an editor, an agent, or a pre-role peer", () => {
    // The absence of a badge IS the editor case — the historical roster is unchanged.
    expect(peerRoleLabel({ author: { kind: "human" }, role: "editor" })).toBeNull();
    expect(peerRoleLabel({ author: { kind: "agent" } })).toBeNull();
    expect(peerRoleLabel({ author: { kind: "human", name: "Ada" } })).toBeNull();
  });

  it("ignores a malformed role value (never over-promotes)", () => {
    expect(peerRoleLabel({ role: "owner" })).toBeNull();
    expect(peerRoleLabel({ role: 42 })).toBeNull();
  });
});
