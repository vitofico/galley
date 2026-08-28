import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import type { Author } from "@galley/shared";
import { CollabDocument, createThread, setThreadStatus, getThreads, getComments, SINGLE_FILE_ID } from "@galley/collab";
import { commentsToRanges, commentRefreshEffect, gutterMarkerChanged } from "./comment-decorations.js";

/**
 * Unit tests for the PURE thread->range mapper that feeds the CodeMirror comment
 * highlights + gutter. No browser/CM view needed: it decodes each OPEN thread's
 * relative-position anchors against the live `Y.Doc` (the same render seam Layer 1
 * exposes via `resolveThreadRange`), keeping resolved + orphaned threads out of the
 * editor paint while leaving them in the cross-file overview (Layer 5).
 *
 * The anchors are built by the real `createThread`, so these cases also pin that
 * the decode survives edits BEFORE the range (offsets shift) and degrades to a
 * dropped range once the whole anchored span is deleted.
 */

const human: Author = { kind: "human", userId: "u1" };

/** A fresh single-file host seeded with `initial` source text. */
function freshDoc(initial: string): CollabDocument {
  return new CollabDocument(initial);
}

describe("commentsToRanges", () => {
  it("maps one open thread to its decoded {from,to,threadId}", () => {
    const doc = freshDoc("hello world");
    const id = createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "look" },
      human,
    );
    expect(commentsToRanges(getThreads(doc), doc.doc)).toEqual([{ from: 6, to: 11, threadId: id }]);
  });

  it("returns an empty array when there are no threads", () => {
    const doc = freshDoc("hello world");
    expect(commentsToRanges(getThreads(doc), doc.doc)).toEqual([]);
  });

  it("drops resolved threads (only open threads paint)", () => {
    const doc = freshDoc("hello world");
    const id = createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 5, anchorText: "hello", body: "x" },
      human,
    );
    expect(commentsToRanges(getThreads(doc), doc.doc)).toHaveLength(1);
    setThreadStatus(doc, id, "resolved", human);
    expect(commentsToRanges(getThreads(doc), doc.doc)).toEqual([]);
  });

  it("shifts the decoded offsets when text is inserted BEFORE the range", () => {
    const doc = freshDoc("hello world");
    const id = createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" },
      human,
    );
    // Insert 3 chars at the very start; the anchored "world" range moves right by 3.
    doc.source.insert(0, "XYZ");
    expect(commentsToRanges(getThreads(doc), doc.doc)).toEqual([{ from: 9, to: 14, threadId: id }]);
  });

  it("drops an ORPHANED thread whose anchored span was fully deleted", () => {
    const doc = freshDoc("hello world");
    createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" },
      human,
    );
    // Delete the whole anchored "world" range -> range collapses -> dropped.
    doc.source.delete(6, 5);
    expect(commentsToRanges(getThreads(doc), doc.doc)).toEqual([]);
    // But the thread itself is kept (with its anchorText) for the overview.
    expect(getThreads(doc)).toHaveLength(1);
  });

  it("maps 1:1 in input order (it is PURE; callers sort before a RangeSetBuilder)", () => {
    const doc = freshDoc("aaaa bbbb cccc");
    createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 10, to: 14, anchorText: "cccc", body: "x" },
      human,
    );
    createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 0, to: 4, anchorText: "aaaa", body: "y" },
      human,
    );
    // The mapper does NOT reorder: each input thread maps to a range at the same
    // index (it is PURE; the ascending-`from` sort RangeSetBuilder needs is the
    // caller's job, done by `rangesForFile`). Asserting positionally against the
    // input avoids depending on `getThreads`' [createdAt,id] tiebreak.
    const threads = getThreads(doc);
    const ranges = commentsToRanges(threads, doc.doc);
    expect(ranges.map((r) => r.threadId)).toEqual(threads.map((t) => t.id));
    // And sorting the output (what `rangesForFile` does) yields ascending `from`.
    const sorted = [...ranges].sort((a, b) => a.from - b.from);
    expect(sorted.map((r) => r.from)).toEqual([0, 10]);
  });

  it("does NOT throw on a garbage-anchored thread (fails closed, drops the range)", () => {
    const doc = freshDoc("hello world");
    const ok = createThread(
      doc,
      { fileId: SINGLE_FILE_ID, ytext: doc.source, from: 6, to: 11, anchorText: "world", body: "x" },
      human,
    );
    // A truncated/hostile sync record: structurally valid thread, garbage anchors.
    doc.doc.transact(() => {
      const t = new Y.Map<unknown>();
      const garbage = new Uint8Array([255, 254, 253, 252, 0, 1, 2, 3]);
      t.set("id", "bad");
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
      getComments(doc).set("bad", t);
    });
    let ranges: ReturnType<typeof commentsToRanges> = [];
    expect(() => {
      ranges = commentsToRanges(getThreads(doc), doc.doc);
    }).not.toThrow();
    // The good thread still paints; the garbage one drops (orphaned), never throws.
    expect(ranges).toEqual([{ from: 6, to: 11, threadId: ok }]);
  });
});

describe("comment gutter — remote arrival repaints the marker (no local edit)", () => {
  it("gutterMarkerChanged fires on a commentRefreshEffect transaction with docChanged=false", () => {
    // The bug: the gutter's `lineMarkerChange` watched only `docChanged`, so a
    // thread arriving over the wire (the plugin dispatches `commentRefreshEffect`
    // out-of-band, docChanged=false) never repainted the ONLY click target until
    // the next local edit. A plain EditorState transaction stands in (no DOM).
    const state = EditorState.create({ doc: "hello world" });
    const tr = state.update({ effects: commentRefreshEffect.of(null) });
    expect(tr.docChanged).toBe(false); // it really is a no-op edit
    expect(gutterMarkerChanged({ docChanged: tr.docChanged, transactions: [tr] })).toBe(true);
  });

  it("gutterMarkerChanged stays true for a real local doc edit", () => {
    const state = EditorState.create({ doc: "hello world" });
    const tr = state.update({ changes: { from: 0, insert: "x" } });
    expect(gutterMarkerChanged({ docChanged: tr.docChanged, transactions: [tr] })).toBe(true);
  });

  it("gutterMarkerChanged is false for an unrelated effect-free no-op", () => {
    const state = EditorState.create({ doc: "hello world" });
    const tr = state.update({ selection: { anchor: 1 } });
    expect(gutterMarkerChanged({ docChanged: tr.docChanged, transactions: [tr] })).toBe(false);
  });
});
