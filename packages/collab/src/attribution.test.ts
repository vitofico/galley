import { describe, it, expect } from "vitest";
import { CollabDocument } from "./index.js";
import {
  registerAuthor,
  renameAuthor,
  authorForClientID,
  distinctAuthors,
  attributedRanges,
  attributionAt,
  observeAttribution,
} from "./attribution.js";
import type { Author } from "@galley/shared";

const HUMAN: Author = { kind: "human", userId: "alice" };
const BOB: Author = { kind: "human", userId: "bob" };
const AGENT: Author = { kind: "agent", runId: "run-7" };

/** Bidirectional, full-state sync between two docs (offline, no websocket). */
function sync(a: CollabDocument, b: CollabDocument): void {
  a.applyUpdate(b.encodeStateSince(a.stateVector()));
  b.applyUpdate(a.encodeStateSince(b.stateVector()));
}

/** Concatenate the ranges' covered text to prove the partition is exact. */
function cover(doc: CollabDocument): string {
  const src = doc.getSource();
  return attributedRanges(doc)
    .map((r) => src.slice(r.from, r.to))
    .join("");
}

describe("attribution core", () => {
  it("attributes a single peer's text to its registered author", () => {
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "hello world"), HUMAN);
    registerAuthor(doc, HUMAN);

    const ranges = attributedRanges(doc);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ from: 0, to: 11, author: HUMAN });
    expect(cover(doc)).toBe("hello world");
  });

  it("registration order does not matter (clientID is stable for the doc)", () => {
    const doc = new CollabDocument("");
    registerAuthor(doc, HUMAN); // register BEFORE inserting
    doc.transact((t) => t.insert(0, "abc"), HUMAN);
    expect(attributionAt(doc, 1)?.author).toEqual(HUMAN);
  });

  it("attributes two peers' spans across the wire (clientID + map both sync)", () => {
    const a = new CollabDocument("");
    const b = new CollabDocument("");

    a.transact((t) => t.insert(0, "AAA"), HUMAN);
    registerAuthor(a, HUMAN);
    sync(a, b);

    // B appends after A's text.
    b.transact((t) => t.insert(t.length, "BBB"), BOB);
    registerAuthor(b, BOB);
    sync(a, b);

    for (const doc of [a, b]) {
      expect(doc.getSource()).toBe("AAABBB");
      const ranges = attributedRanges(doc);
      expect(ranges.map((r) => [r.from, r.to])).toEqual([
        [0, 3],
        [3, 6],
      ]);
      expect(ranges[0]!.author).toEqual(HUMAN);
      expect(ranges[1]!.author).toEqual(BOB);
    }
  });

  it("resolves attribution lazily when the author map arrives after the text", () => {
    const a = new CollabDocument("");
    const b = new CollabDocument("");
    a.transact((t) => t.insert(0, "data"), HUMAN);
    registerAuthor(a, HUMAN);

    // Deliver ONLY the text update to b (not the authors-map entry yet) by
    // syncing text before registering... simulate by syncing then checking that
    // an unknown client resolves to undefined.
    const fresh = new CollabDocument("");
    fresh.transact((t) => t.insert(0, "orphan"), HUMAN); // different doc → different clientID, never registered here
    expect(attributedRanges(fresh)[0]!.author).toBeUndefined();

    sync(a, b);
    expect(attributedRanges(b)[0]!.author).toEqual(HUMAN);
  });

  it("excludes deleted text and attributes a delete+insert replace to the replacer", () => {
    const a = new CollabDocument("");
    a.transact((t) => t.insert(0, "OLD"), HUMAN);
    registerAuthor(a, HUMAN);

    const b = new CollabDocument("");
    sync(a, b);

    // B replaces the middle: delete "OLD", insert "NEW" (agent-as-peer style).
    b.transact((t) => {
      t.delete(0, 3);
      t.insert(0, "NEW");
    }, AGENT);
    registerAuthor(b, AGENT);
    sync(a, b);

    for (const doc of [a, b]) {
      expect(doc.getSource()).toBe("NEW");
      const ranges = attributedRanges(doc);
      expect(cover(doc)).toBe("NEW");
      // The deleted "OLD" must not appear; the visible span is the agent's.
      expect(ranges.every((r) => r.author?.kind === "agent")).toBe(true);
    }
  });

  it("survives a reload: old spans keep their author, new edits get the new clientID", () => {
    const original = new CollabDocument("");
    original.transact((t) => t.insert(0, "kept"), HUMAN);
    registerAuthor(original, HUMAN);
    const state = original.encodeState();

    // Reload = a brand new Y.Doc (new clientID) hydrated from persisted state.
    const reloaded = new CollabDocument();
    reloaded.applyUpdate(state);
    expect(reloaded.getSource()).toBe("kept");
    // The old human's clientID entry survived, so the old span still resolves.
    expect(attributedRanges(reloaded)[0]!.author).toEqual(HUMAN);

    // The same human now edits under a NEW clientID; register and append.
    registerAuthor(reloaded, HUMAN);
    reloaded.transact((t) => t.insert(t.length, "more"), HUMAN);
    expect(attributionAt(reloaded, 5)?.author).toEqual(HUMAN);
  });

  it("attributes the agent as a distinct peer", () => {
    const human = new CollabDocument("");
    human.transact((t) => t.insert(0, "intro "), HUMAN);
    registerAuthor(human, HUMAN);

    const agent = new CollabDocument();
    agent.applyUpdate(human.encodeState());
    agent.transact((t) => t.insert(t.length, "by agent"), AGENT);
    registerAuthor(agent, AGENT);

    sync(human, agent);
    const ranges = attributedRanges(human);
    expect(ranges[0]!.author).toEqual(HUMAN);
    expect(ranges[ranges.length - 1]!.author).toEqual(AGENT);
    expect(human.getSource()).toBe("intro by agent");
  });

  it("keeps UTF-16 offsets correct across astral characters", () => {
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "a😀b"), HUMAN);
    registerAuthor(doc, HUMAN);
    const r = attributedRanges(doc);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ from: 0, to: 4 }); // 😀 is 2 UTF-16 units
    expect(cover(doc)).toBe("a😀b");
  });

  it("registerAuthor is idempotent for the same author but throws on a conflict", () => {
    const doc = new CollabDocument("");
    registerAuthor(doc, HUMAN);
    registerAuthor(doc, { kind: "human", userId: "alice" }); // same identity → no-op
    expect(authorForClientID(doc, doc.doc.clientID)).toEqual(HUMAN);
    // Rebinding the same clientID to a different identity would silently
    // reattribute every span it ever wrote — forbidden.
    expect(() => registerAuthor(doc, AGENT)).toThrow(/different author|one peer/i);
  });

  it("attributes by ORIGINATING clientID — the agent must be a distinct peer (invariant)", () => {
    // An agent-tagged transaction on the HUMAN's own doc does NOT make the text
    // agent-authored: Yjs items carry the doc's clientID, not the transaction
    // origin. Correct agent attribution requires a separate agent peer/doc.
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "human text "), HUMAN);
    registerAuthor(doc, HUMAN);
    doc.transact((t) => t.insert(t.length, "agent text"), AGENT); // same clientID!
    expect(attributedRanges(doc).every((r) => r.author?.kind === "human")).toBe(true);
  });

  it("authorForClientID resolves the current doc's own author", () => {
    const doc = new CollabDocument("");
    registerAuthor(doc, BOB);
    expect(authorForClientID(doc, doc.doc.clientID)).toEqual(BOB);
    expect(authorForClientID(doc, 999999)).toBeUndefined();
  });

  it("distinctAuthors is empty before any author registers", () => {
    const doc = new CollabDocument("");
    expect(distinctAuthors(doc)).toEqual([]);
  });

  it("distinctAuthors returns the single author of a solo doc", () => {
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "hi"), HUMAN);
    registerAuthor(doc, HUMAN);
    expect(distinctAuthors(doc)).toEqual([HUMAN]);
  });

  it("distinctAuthors collects every distinct registered author after sync", () => {
    const a = new CollabDocument("");
    a.transact((t) => t.insert(0, "a"), HUMAN);
    registerAuthor(a, HUMAN);
    const b = new CollabDocument();
    sync(a, b);
    b.transact((t) => t.insert(0, "b"), AGENT);
    registerAuthor(b, AGENT);
    sync(a, b);

    const authors = distinctAuthors(a);
    expect(authors).toHaveLength(2);
    expect(authors).toContainEqual(HUMAN);
    expect(authors).toContainEqual(AGENT);
  });

  it("distinctAuthors dedupes two clientIDs bound to the same identity", () => {
    // A peer reconnecting gets a fresh clientID but the SAME human identity; both
    // register, and the union must collapse them to one author entry.
    const first = new CollabDocument("");
    first.transact((t) => t.insert(0, "x"), HUMAN);
    registerAuthor(first, HUMAN);

    const second = new CollabDocument();
    sync(first, second);
    second.transact((t) => t.insert(0, "y"), HUMAN); // a different clientID, same userId
    registerAuthor(second, HUMAN);
    sync(first, second);

    expect(distinctAuthors(first)).toEqual([HUMAN]);
  });

  it("observeAttribution fires on text edits and author registrations", () => {
    const doc = new CollabDocument("");
    let calls = 0;
    const off = observeAttribution(doc, () => (calls += 1));
    doc.transact((t) => t.insert(0, "x"), HUMAN);
    registerAuthor(doc, HUMAN);
    off();
    doc.transact((t) => t.insert(0, "y"), HUMAN); // after off → no more calls
    expect(calls).toBe(2);
  });
});

describe("renameAuthor (the display-name-freeze fix)", () => {
  it("updates the label a peer's spans resolve to, keeping identity on userId", () => {
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "hello"), HUMAN);
    registerAuthor(doc, { ...HUMAN, name: "Al" });
    expect(attributedRanges(doc)[0]!.author).toMatchObject({ userId: "alice", name: "Al" });

    expect(renameAuthor(doc, "alice", "Alice Cooper")).toBe(true);
    // Same identity, new label — on the live spans AND distinctAuthors.
    expect(attributedRanges(doc)[0]!.author).toEqual({
      kind: "human",
      userId: "alice",
      name: "Alice Cooper",
    });
    expect(distinctAuthors(doc)).toEqual([{ kind: "human", userId: "alice", name: "Alice Cooper" }]);
  });

  it("renames EVERY clientID bound to the userId (a peer that reconnected)", () => {
    // Two clientIDs, one identity (the reconnect case distinctAuthors dedupes).
    const a = new CollabDocument("");
    a.transact((t) => t.insert(0, "AA"), HUMAN);
    registerAuthor(a, { ...HUMAN, name: "Al" });
    const b = new CollabDocument();
    sync(a, b);
    b.transact((t) => t.insert(t.length, "BB"), HUMAN); // same userId, fresh clientID
    registerAuthor(b, { ...HUMAN, name: "Al" });
    sync(a, b);

    expect(renameAuthor(a, "alice", "Ada")).toBe(true);
    sync(a, b);
    // BOTH spans (both clientIDs) now resolve to the new label, on both peers.
    for (const doc of [a, b]) {
      const names = attributedRanges(doc).map((r) => (r.author as { name?: string }).name);
      expect(names).toEqual(["Ada", "Ada"]);
      expect(distinctAuthors(doc)).toEqual([{ kind: "human", userId: "alice", name: "Ada" }]);
    }
  });

  it("touches only the named user — other humans and agents are untouched", () => {
    // Three identities require three peers (one clientID = one author); sync them
    // into `a` so its authors map holds all three.
    const a = new CollabDocument("");
    a.transact((t) => t.insert(0, "A"), HUMAN);
    registerAuthor(a, { ...HUMAN, name: "Al" });
    const b = new CollabDocument();
    sync(a, b);
    b.transact((t) => t.insert(t.length, "B"), BOB);
    registerAuthor(b, { ...BOB, name: "Bob" });
    const c = new CollabDocument();
    sync(b, c);
    c.transact((t) => t.insert(t.length, "C"), AGENT);
    registerAuthor(c, AGENT);
    sync(a, b);
    sync(a, c);

    expect(renameAuthor(a, "alice", "Ada")).toBe(true);
    const authors = distinctAuthors(a);
    const human = (uid: string) =>
      authors.find((x) => x.kind === "human" && x.userId === uid) as
        | { name?: string }
        | undefined;
    expect(human("alice")).toMatchObject({ name: "Ada" });
    expect(human("bob")).toMatchObject({ name: "Bob" }); // untouched
    expect(authors.some((x) => x.kind === "agent")).toBe(true); // untouched
    expect(authors).toHaveLength(3);
  });

  it("crosses the wire: a rename on one peer reaches the other", () => {
    const a = new CollabDocument("");
    a.transact((t) => t.insert(0, "x"), HUMAN);
    registerAuthor(a, { ...HUMAN, name: "Al" });
    const b = new CollabDocument();
    sync(a, b);

    renameAuthor(a, "alice", "Alice");
    sync(a, b);
    expect(attributedRanges(b)[0]!.author).toMatchObject({ userId: "alice", name: "Alice" });
  });

  it("is a no-op (returns false) for a blank name, no matching user, or no change", () => {
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "x"), HUMAN);
    registerAuthor(doc, { ...HUMAN, name: "Al" });

    expect(renameAuthor(doc, "alice", "   ")).toBe(false); // blank
    expect(renameAuthor(doc, "nobody", "Z")).toBe(false); // no such user
    expect(renameAuthor(doc, "alice", "Al")).toBe(false); // already that name
    expect(attributedRanges(doc)[0]!.author).toMatchObject({ name: "Al" });
  });

  it("fires the author observer once per rename (single transaction)", () => {
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "x"), HUMAN);
    registerAuthor(doc, { ...HUMAN, name: "Al" });
    let calls = 0;
    const off = observeAttribution(doc, () => (calls += 1));
    renameAuthor(doc, "alice", "Ada");
    off();
    expect(calls).toBe(1);
  });
});
