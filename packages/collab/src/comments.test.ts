/**
 * LAYER 1 unit suite (TDD-first) for the source-anchored comments model.
 *
 * Mirrors the fixtures + two-peer `sync` helper style of `collab-project.test.ts`.
 * The cases pin the contract the render seam depends on:
 *   - relative-position anchors STAY put when text is inserted/deleted before,
 *     after, or strictly inside the range;
 *   - deleting the WHOLE anchored range ORPHANS the thread — `resolveThreadRange`
 *     returns null, but the thread is kept (with `anchorText`) and still listed;
 *   - concurrent replies on two peers both survive sync and stay ordered;
 *   - a concurrent resolve-vs-reply converges (status LWW) AND keeps the message.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import { CollabDocument } from "./collab-document.js";
import {
  createThread,
  createThreadAnchored,
  encodeAnchor,
  addMessage,
  setThreadStatus,
  getThreads,
  getThread,
  observeComments,
  resolveAnchor,
  resolveThreadRange,
  SINGLE_FILE_ID,
  getComments,
} from "./comments.js";

const human: Author = { kind: "human", userId: "u1" };
const agent: Author = { kind: "agent", runId: "r1" };
const other: Author = { kind: "human", userId: "u2" };

/** Full-state exchange between two docs (stands in for the sync slice). */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

/** A fresh single-file host seeded with `initial` source text. */
function freshDoc(initial: string): CollabDocument {
  return new CollabDocument(initial);
}

describe("comments — createThread + getThreads", () => {
  it("creates an open thread anchored to a range, seeded with the first message", () => {
    const doc = freshDoc("hello world");
    const id = createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "look here" },
      human,
    );
    expect(typeof id).toBe("string");
    const threads = getThreads(doc);
    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t.id).toBe(id);
    expect(t.fileId).toBe(SINGLE_FILE_ID);
    expect(t.status).toBe("open");
    expect(t.anchorText).toBe("world");
    expect(t.createdBy).toEqual(human);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]!.author).toEqual(human);
    expect(t.messages[0]!.body).toBe("look here");
    expect(getThread(doc, id)).toEqual(t);
  });

  it("mints distinct ids for two threads", () => {
    const doc = freshDoc("abcdef");
    const a = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 2, anchorText: "ab", body: "x" }, human);
    const b = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 3, to: 5, anchorText: "de", body: "y" }, human);
    expect(a).not.toBe(b);
    expect(getThreads(doc)).toHaveLength(2);
  });

  it("writes through a transaction tagged with the author origin", () => {
    const doc = freshDoc("hello world");
    const origins: unknown[] = [];
    doc.doc.on("afterTransaction", (txn: Y.Transaction) => origins.push(txn.origin));
    createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "hi" }, human);
    expect(origins).toContain("human:u1");
  });
});

describe("comments — anchor stability (resolveThreadRange)", () => {
  it("decodes back to the original range with no edits", () => {
    const doc = freshDoc("hello world");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" }, human);
    const range = resolveThreadRange(doc, getThread(doc, id)!);
    expect(range).toEqual({ from: 6, to: 11 });
  });

  it("stays put when text is inserted BEFORE the range", () => {
    const doc = freshDoc("hello world");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" }, human);
    doc.transact((t) => t.insert(0, "say: "), human); // shift everything right by 5
    expect(resolveThreadRange(doc, getThread(doc, id)!)).toEqual({ from: 11, to: 16 });
  });

  it("does NOT move when text is inserted AFTER the range", () => {
    const doc = freshDoc("hello world");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "x" }, human);
    doc.transact((t) => t.insert(t.length, "!!!"), human);
    expect(resolveThreadRange(doc, getThread(doc, id)!)).toEqual({ from: 0, to: 5 });
  });

  it("grows the range when text is inserted INSIDE it", () => {
    const doc = freshDoc("hello world");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" }, human);
    doc.transact((t) => t.insert(8, "XX"), human); // "wo" + "XX" + "rld"
    const range = resolveThreadRange(doc, getThread(doc, id)!);
    expect(range).toEqual({ from: 6, to: 13 });
  });

  it("shrinks when text inside the range is deleted but some remains", () => {
    const doc = freshDoc("hello world");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" }, human);
    doc.transact((t) => t.delete(7, 2), human); // delete "or" from "world"
    const range = resolveThreadRange(doc, getThread(doc, id)!);
    expect(range).toEqual({ from: 6, to: 9 });
  });
});

describe("comments — orphaning", () => {
  it("orphans (returns null) when the whole anchored range is deleted, but keeps the thread + anchorText", () => {
    const doc = freshDoc("hello world");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" }, human);
    doc.transact((t) => t.delete(6, 5), human); // delete "world" entirely
    expect(resolveThreadRange(doc, getThread(doc, id)!)).toBeNull();
    // thread is still present and remembers what it pointed at
    const threads = getThreads(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.anchorText).toBe("world");
  });

  it("resolveAnchor returns null for bytes that cannot decode against the doc", () => {
    const doc = freshDoc("abc");
    expect(resolveAnchor(doc.doc, new Uint8Array([0, 0, 0]))).toBeNull();
  });
});

describe("comments — addMessage + setThreadStatus", () => {
  it("appends messages in order", () => {
    const doc = freshDoc("hello");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "first" }, human);
    addMessage(doc, id, "second", other);
    addMessage(doc, id, "third", human);
    const t = getThread(doc, id)!;
    expect(t.messages.map((m) => m.body)).toEqual(["first", "second", "third"]);
    expect(t.messages[1]!.author).toEqual(other);
  });

  it("flips status open -> resolved -> open", () => {
    const doc = freshDoc("hello");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "x" }, human);
    expect(getThread(doc, id)!.status).toBe("open");
    setThreadStatus(doc, id, "resolved", human);
    expect(getThread(doc, id)!.status).toBe("resolved");
    setThreadStatus(doc, id, "open", human);
    expect(getThread(doc, id)!.status).toBe("open");
  });
});

describe("comments — observeComments", () => {
  it("fires on create, on a nested message append, and on a status flip; unsubscribe stops it", () => {
    const doc = freshDoc("hello");
    let hits = 0;
    const off = observeComments(doc, () => {
      hits++;
    });
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "x" }, human);
    expect(hits).toBeGreaterThanOrEqual(1);
    const afterCreate = hits;
    addMessage(doc, id, "reply", human); // nested mutation -> needs observeDeep
    expect(hits).toBeGreaterThan(afterCreate);
    const afterMsg = hits;
    setThreadStatus(doc, id, "resolved", human); // nested field flip -> needs observeDeep
    expect(hits).toBeGreaterThan(afterMsg);
    off();
    const frozen = hits;
    addMessage(doc, id, "ignored", human);
    expect(hits).toBe(frozen);
  });
});

describe("comments — concurrent convergence (two peers)", () => {
  it("concurrent replies on two peers both survive sync and stay ordered", () => {
    const a = freshDoc("hello world");
    const b = new CollabDocument("", new Y.Doc());
    // seed the thread on A, then sync so B has it
    const id = createThread(a, { fileId: SINGLE_FILE_ID, ytext: a.source, from: 6, to: 11, anchorText: "world", body: "root" }, human);
    sync(a.doc, b.doc);
    expect(getThread(b, id)!.messages).toHaveLength(1);
    // each peer replies WITHOUT seeing the other's reply, then they sync
    addMessage(a, id, "from A", human);
    addMessage(b, id, "from B", other);
    sync(a.doc, b.doc);
    const fromA = getThread(a, id)!.messages.map((m) => m.body);
    const fromB = getThread(b, id)!.messages.map((m) => m.body);
    expect(fromA).toEqual(fromB); // converged to the same order
    expect(fromA).toContain("from A");
    expect(fromA).toContain("from B");
    expect(fromA[0]).toBe("root");
    expect(fromA).toHaveLength(3);
  });

  it("concurrent resolve-vs-reply converges: status is LWW and the message is kept", () => {
    const a = freshDoc("hello world");
    const b = new CollabDocument("", new Y.Doc());
    const id = createThread(a, { fileId: SINGLE_FILE_ID, ytext: a.source, from: 6, to: 11, anchorText: "world", body: "root" }, human);
    sync(a.doc, b.doc);
    // A resolves; B (not seeing the resolve) replies. Then they sync.
    setThreadStatus(a, id, "resolved", human);
    addMessage(b, id, "but wait", other);
    sync(a.doc, b.doc);
    const ta = getThread(a, id)!;
    const tb = getThread(b, id)!;
    expect(ta.status).toBe(tb.status); // converged (LWW)
    // the concurrent reply is NOT lost regardless of who won the status race
    expect(ta.messages.map((m) => m.body)).toContain("but wait");
    expect(tb.messages.map((m) => m.body)).toContain("but wait");
    expect(ta.messages).toEqual(tb.messages);
  });

  it("anchors decode identically on a synced peer", () => {
    const a = freshDoc("hello world");
    const b = new CollabDocument("", new Y.Doc());
    const id = createThread(a, { fileId: SINGLE_FILE_ID, ytext: a.source, from: 6, to: 11, anchorText: "world", body: "x" }, human);
    sync(a.doc, b.doc);
    expect(resolveThreadRange(b, getThread(b, id)!)).toEqual({ from: 6, to: 11 });
  });
});

describe("comments — defensive reads", () => {
  it("getThread returns undefined for an unknown id", () => {
    const doc = freshDoc("hello");
    expect(getThread(doc, "nope")).toBeUndefined();
  });

  it("skips a malformed record but keeps well-formed ones", () => {
    const doc = freshDoc("hello");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "x" }, human);
    // a hostile/buggy peer forges garbage straight into the map
    doc.doc.transact(() => getComments(doc).set("garbage", new Y.Map<unknown>()));
    const threads = getThreads(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(id);
  });

  it("agent-authored threads carry the agent author", () => {
    const doc = freshDoc("hello");
    const id = createThread(doc, { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "auto" }, agent);
    expect(getThread(doc, id)!.createdBy).toEqual(agent);
  });
});

describe("comments — undecodable anchors fail closed (CRDT DoS guard)", () => {
  /**
   * Forge a STRUCTURALLY-VALID thread (passes `readThread`) whose anchor bytes are
   * garbage — exactly what a truncated/hostile sync record looks like. The decode
   * path (`resolveAnchor` -> `Y.decodeRelativePosition`) must NOT throw out of the
   * unguarded render path; it degrades to ORPHANED instead.
   */
  function forgeGarbageThread(doc: CollabDocument, id: string): void {
    const garbage = new Uint8Array([255, 254, 253, 252, 0, 1, 2, 3]);
    doc.doc.transact(() => {
      const t = new Y.Map<unknown>();
      t.set("id", id);
      t.set("fileId", SINGLE_FILE_ID);
      t.set("anchorStart", garbage);
      t.set("anchorEnd", garbage);
      t.set("anchorText", "gone");
      t.set("status", "open");
      t.set("createdAt", Date.now());
      t.set("createdBy", { kind: "human", userId: "u1" });
      const messages = new Y.Array<Y.Map<unknown>>();
      const m = new Y.Map<unknown>();
      m.set("id", "m1");
      m.set("author", { kind: "human", userId: "u1" });
      m.set("body", "hi");
      m.set("createdAt", Date.now());
      m.set("mentions", []);
      messages.push([m]);
      t.set("messages", messages);
      getComments(doc).set(id, t);
    });
  }

  it("resolveAnchor returns null on garbage bytes instead of throwing", () => {
    const doc = freshDoc("hello");
    const garbage = new Uint8Array([255, 254, 253, 252, 0, 1, 2, 3]);
    expect(() => resolveAnchor(doc.doc, garbage)).not.toThrow();
    expect(resolveAnchor(doc.doc, garbage)).toBeNull();
  });

  it("getThreads + resolveThreadRange treat a garbage-anchored thread as orphaned", () => {
    const doc = freshDoc("hello");
    forgeGarbageThread(doc, "g1");
    let threads: ReturnType<typeof getThreads> = [];
    expect(() => {
      threads = getThreads(doc);
    }).not.toThrow();
    // The thread is still present (kept with its anchorText, like any orphan)…
    expect(threads).toHaveLength(1);
    expect(threads[0]!.anchorText).toBe("gone");
    // …but its range fails to resolve -> orphaned (null), without throwing.
    expect(() => resolveThreadRange(doc, threads[0]!)).not.toThrow();
    expect(resolveThreadRange(doc, threads[0]!)).toBeNull();
  });
});

describe("comments — createThreadAnchored (pre-encoded anchors)", () => {
  it("anchors a thread from bytes encoded at selection time", () => {
    const doc = freshDoc("hello world");
    const anchorStart = encodeAnchor(doc.source, 6);
    const anchorEnd = encodeAnchor(doc.source, 11);
    const id = createThreadAnchored(
      doc,
      { fileId: SINGLE_FILE_ID, anchorStart, anchorEnd, anchorText: "world", body: "x" },
      human,
    );
    expect(resolveThreadRange(doc, getThread(doc, id)!)).toEqual({ from: 6, to: 11 });
  });

  it("selection-time anchors survive an edit BEFORE the range during the compose window", () => {
    // The bug: encoding at submit time off stale offsets mis-anchors when a remote
    // edit lands before the range mid-compose. Encoding at selection time fixes it.
    const doc = freshDoc("hello world");
    const anchorStart = encodeAnchor(doc.source, 6); // "world"
    const anchorEnd = encodeAnchor(doc.source, 11);
    // A concurrent edit inserts 5 chars before the range, AFTER the anchor was taken.
    doc.transact((t) => t.insert(0, "say: "), human);
    const id = createThreadAnchored(
      doc,
      { fileId: SINGLE_FILE_ID, anchorStart, anchorEnd, anchorText: "world", body: "x" },
      human,
    );
    // The anchor rebased with the insert -> still points at "world" (now at 11..16),
    // not the stale 6..11 (which would now be "world" shifted, i.e. wrong text).
    const range = resolveThreadRange(doc, getThread(doc, id)!);
    expect(range).toEqual({ from: 11, to: 16 });
    expect(doc.source.toString().slice(range!.from, range!.to)).toBe("world");
  });
});
