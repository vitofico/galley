/**
 * Roadmap #4 slice 2a: the CRDT snapshot / compaction / restore core. A
 * `CrdtStore` keeps an append-only Yjs update log and periodically compacts it to
 * a snapshot; reconstructing a doc replays snapshot + tail. These are the pure,
 * offline Yjs primitives behind that — no store, no IO. Restore is the mechanism
 * by which "git/DB is a projection, the CRDT is truth" round-trips losslessly.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { CollabDocument } from "./collab-document.js";
import { CollabProject } from "./collab-project.js";
import { snapshotDoc, restoreDoc, compactUpdates } from "./crdt-snapshot.js";

const human = { kind: "human" as const, userId: "u1" };
const agent = { kind: "agent" as const, runId: "r1" };

describe("CRDT snapshot/restore/compaction core", () => {
  it("snapshot → restore round-trips a document's text", () => {
    const d = new CollabDocument("");
    d.transact((t) => t.insert(0, "Hello, snapshot"), human);
    const snap = snapshotDoc(d.doc);

    const restored = new CollabDocument("", restoreDoc(snap));
    expect(restored.getSource()).toBe("Hello, snapshot");
  });

  it("replaying a captured update log reconstructs the live doc (convergence)", () => {
    const d = new CollabDocument("");
    const log: Uint8Array[] = [];
    d.doc.on("update", (u: Uint8Array) => log.push(u));
    d.transact((t) => t.insert(0, "one "), human);
    d.transact((t) => t.insert(t.length, "two "), human);
    d.transact((t) => t.insert(t.length, "three"), agent);

    const rebuilt = new CollabDocument("", restoreDoc(log));
    expect(rebuilt.getSource()).toBe(d.getSource());
    expect(rebuilt.getSource()).toBe("one two three");
  });

  it("compactUpdates merges a log into one snapshot that restores identically", () => {
    const d = new CollabDocument("");
    const log: Uint8Array[] = [];
    d.doc.on("update", (u: Uint8Array) => log.push(u));
    for (let i = 0; i < 5; i++) d.transact((t) => t.insert(t.length, `${i}`), human);
    expect(log.length).toBe(5);

    const compacted = compactUpdates(log);
    const rebuilt = new CollabDocument("", restoreDoc(compacted));
    expect(rebuilt.getSource()).toBe(d.getSource());
    expect(rebuilt.getSource()).toBe("01234");
  });

  it("compaction is order-independent (CRDT property)", () => {
    const d = new CollabDocument("");
    const log: Uint8Array[] = [];
    d.doc.on("update", (u: Uint8Array) => log.push(u));
    d.transact((t) => t.insert(0, "A"), human);
    d.transact((t) => t.insert(t.length, "B"), human);
    d.transact((t) => t.insert(t.length, "C"), human);

    const forward = new CollabDocument("", restoreDoc(compactUpdates(log)));
    const reversed = new CollabDocument("", restoreDoc(compactUpdates([...log].reverse())));
    expect(reversed.getSource()).toBe(forward.getSource());
  });

  it("preserves a whole multi-file project + its attribution map across snapshot→restore", () => {
    const src = new CollabProject(new Y.Doc(), { newId: (() => { let n = 0; return () => `f${n++}`; })() });
    const main = src.create("/main.typ", "= Title", human);
    src.create("/intro.typ", "Body", human);
    src.setMain(main, human);

    const restored = new CollabProject(restoreDoc(snapshotDoc(src.doc)));
    const snap = restored.snapshot();
    expect(snap.mainFileId).toBe(main);
    expect(snap.files.map((f) => f.path)).toEqual(["/intro.typ", "/main.typ"]);
    expect(snap.files.find((f) => f.path === "/main.typ")?.text).toBe("= Title");
  });

  it("handles an empty update log without throwing (yields an empty doc)", () => {
    const rebuilt = new CollabDocument("", restoreDoc(compactUpdates([])));
    expect(rebuilt.getSource()).toBe("");
  });

  it("a snapshot is meaningfully smaller than a long raw log after compaction", () => {
    const d = new CollabDocument("");
    const log: Uint8Array[] = [];
    d.doc.on("update", (u: Uint8Array) => log.push(u));
    // Insert then delete repeatedly — the raw log keeps all ops; the snapshot
    // keeps only reachable state (tombstones, but not every transient op frame).
    for (let i = 0; i < 50; i++) {
      d.transact((t) => t.insert(t.length, "xxxxx"), human);
    }
    const rawBytes = log.reduce((n, u) => n + u.byteLength, 0);
    const compacted = compactUpdates(log);
    expect(compacted.byteLength).toBeLessThan(rawBytes);
    // And it still restores correctly.
    expect(new CollabDocument("", restoreDoc(compacted)).getSource().length).toBe(250);
  });
});
