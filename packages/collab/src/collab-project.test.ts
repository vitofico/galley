import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import { isProjectInput } from "@galley/shared";
import { CollabProject } from "./collab-project.js";
import { CollabConnection } from "./collab-connection.js";
import { InMemoryNetwork } from "./transport.js";
import { registerAuthor, textAttributedRanges } from "./attribution.js";
import { createThread, addMessage, setThreadStatus, getThreads } from "./comments.js";

const human: Author = { kind: "human", userId: "u1" };
const agent: Author = { kind: "agent", runId: "r1" };

/** A deterministic id generator for tests (`p1`, `p2`, … by prefix). */
function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/** Full-state exchange between two project docs (stands in for the sync slice). */
function sync(a: CollabProject, b: CollabProject): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
}

describe("CollabProject — files, ids, main", () => {
  it("creates a file, reflects path+text, and auto-assigns the first file as main", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const id = p.create("/main.typ", "= Hello", human);
    expect(id).toBe("f1");
    const file = p.getFile(id)!;
    expect(file.path).toBe("/main.typ");
    expect(file.text).toBe("= Hello");
    expect(file.deleted).toBe(false);
    expect(p.mainFileId()).toBe("f1");
  });

  it("canonicalizes a path that lacks a leading slash", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const id = p.create("chapters/intro.typ", "x", human);
    expect(p.getFile(id)!.path).toBe("/chapters/intro.typ");
  });

  it("a second file does not steal main", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    p.create("/main.typ", "a", human);
    const second = p.create("/lib.typ", "b", human);
    expect(p.mainFileId()).toBe("f1");
    expect(second).toBe("f2");
  });

  it("setMain switches main; rejects unknown and deleted files", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const a = p.create("/main.typ", "a", human);
    const b = p.create("/lib.typ", "b", human);
    p.setMain(b, human);
    expect(p.mainFileId()).toBe(b);
    expect(() => p.setMain("nope", human)).toThrow();
    p.delete(a, human);
    expect(() => p.setMain(a, human)).toThrow(/deleted/);
  });
});

describe("CollabProject — rename/delete preserve history (stable fileId)", () => {
  it("rename changes the path but keeps the same fileId and text (history retained)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const id = p.create("/old.typ", "body text", human);
    const textBefore = p.fileText(id);
    p.rename(id, "/new.typ", human);
    expect(p.getFile(id)!.path).toBe("/new.typ");
    expect(p.getFile(id)!.text).toBe("body text");
    // Same Y.Text instance => CRDT history + attribution survive the rename.
    expect(p.fileText(id)).toBe(textBefore);
  });

  it("delete tombstones the file but RETAINS its Y.Text (un-delete restores content)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const id = p.create("/a.typ", "keep me", human);
    const textInstance = p.fileText(id);
    p.delete(id, human);
    expect(p.getFile(id)!.deleted).toBe(true);
    // Y.Text is retained (same instance), so content + attribution are intact.
    expect(p.fileText(id)).toBe(textInstance);
    expect(p.fileText(id)!.toString()).toBe("keep me");
    p.restore(id, human);
    expect(p.getFile(id)!.deleted).toBe(false);
    expect(p.getFile(id)!.text).toBe("keep me");
  });

  it("rename is unaffected by setMain pointing at a fileId (main survives rename)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const id = p.create("/main.typ", "x", human);
    p.rename(id, "/renamed.typ", human);
    expect(p.mainFileId()).toBe(id);
    expect(p.toProjectInput()!.main).toBe("/renamed.typ");
  });
});

describe("CollabProject — toProjectInput / duplicate-path conflicts", () => {
  it("builds a ProjectInput from live files, sorted by path, with the main path", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    p.create("/main.typ", '#import "/lib.typ": x\n#x', human);
    p.create("/lib.typ", "#let x = [v]", human);
    const input = p.toProjectInput()!;
    expect(isProjectInput(input)).toBe(true);
    expect(input.main).toBe("/main.typ");
    expect(input.files.map((f) => f.path)).toEqual(["/lib.typ", "/main.typ"]);
  });

  it("excludes deleted files from the compile input", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    p.create("/main.typ", "a", human);
    const dead = p.create("/dead.typ", "b", human);
    p.delete(dead, human);
    expect(p.toProjectInput()!.files.map((f) => f.path)).toEqual(["/main.typ"]);
  });

  it("returns null when the main file is deleted (no auto-reassign)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const main = p.create("/main.typ", "a", human);
    p.create("/lib.typ", "b", human);
    p.delete(main, human);
    expect(p.toProjectInput()).toBeNull();
    expect(p.mainFileId()).toBe(main); // unchanged — caller must setMain explicitly
  });

  it("detects duplicate live paths and refuses to compile until resolved", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const main = p.create("/main.typ", "m", human); // main is a distinct, unique path
    p.create("/dup.typ", "a", human);
    p.create("/dup.typ", "b", human);
    p.setMain(main, human);
    expect(p.duplicatePaths()).toEqual(["/dup.typ"]);
    expect(p.toProjectInput()).toBeNull();
  });

  it("resolving a duplicate path (rename one) clears the conflict", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const a = p.create("/dup.typ", "a", human);
    const b = p.create("/dup.typ", "b", human);
    p.setMain(a, human);
    expect(p.duplicatePaths()).toEqual(["/dup.typ"]);
    p.rename(b, "/other.typ", human);
    expect(p.duplicatePaths()).toEqual([]);
    expect(p.toProjectInput()!.files.map((f) => f.path)).toEqual(["/dup.typ", "/other.typ"]);
  });
});

describe("CollabProject — CRDT convergence across peers", () => {
  it("a file created on one peer appears on the other after sync", () => {
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    const b = new CollabProject(new Y.Doc(), { newId: ids("b") });
    const id = a.create("/main.typ", "hello", human);
    sync(a, b);
    expect(b.getFile(id)?.text).toBe("hello");
    expect(b.mainFileId()).toBe(id);
  });

  it("concurrent create of the SAME path on two peers surfaces a duplicate-path conflict (distinct fileIds)", () => {
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    const b = new CollabProject(new Y.Doc(), { newId: ids("b") });
    a.create("/main.typ", "from A", human);
    b.create("/main.typ", "from B", human);
    sync(a, b);
    // Two distinct fileIds, same path -> a conflict both peers can see.
    expect(a.duplicatePaths()).toEqual(["/main.typ"]);
    expect(b.duplicatePaths()).toEqual(["/main.typ"]);
    expect(a.snapshot().files.filter((f) => !f.deleted)).toHaveLength(2);
  });

  it("concurrent edits to two different files both survive the merge", () => {
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    const b = new CollabProject(new Y.Doc(), { newId: ids("b") });
    const m = a.create("/main.typ", "M", human);
    const l = a.create("/lib.typ", "L", human);
    sync(a, b);
    a.transactFile(m, (t) => t.insert(t.length, "+a"), human);
    b.transactFile(l, (t) => t.insert(t.length, "+b"), human);
    sync(a, b);
    expect(a.getFile(m)!.text).toBe("M+a");
    expect(a.getFile(l)!.text).toBe("L+b");
    expect(b.getFile(m)!.text).toBe("M+a");
    expect(b.getFile(l)!.text).toBe("L+b");
  });
});

describe("CollabProject — seed-once + id guard", () => {
  it("seedIfPristine seeds a pristine doc and skips a doc with history", () => {
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    const seeded = a.seedIfPristine(
      [
        { path: "/main.typ", text: "M" },
        { path: "/lib.typ", text: "L" },
      ],
      "/main.typ",
      human,
    );
    expect(seeded).not.toBeNull();
    expect(a.toProjectInput()!.main).toBe("/main.typ");
    expect(a.toProjectInput()!.files).toHaveLength(2);
    // Second call: doc now has history -> no re-seed (no duplication).
    expect(a.seedIfPristine([{ path: "/x.typ", text: "X" }], "/x.typ", human)).toBeNull();
    expect(a.snapshot().files).toHaveLength(2);
  });

  it("a peer that received state is non-pristine, so it does not re-seed (no doubling)", () => {
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    a.seedIfPristine([{ path: "/main.typ", text: "M" }], "/main.typ", human);
    const b = new CollabProject(new Y.Doc(), { newId: ids("b") });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.seedIfPristine([{ path: "/main.typ", text: "M" }], "/main.typ", human)).toBeNull();
    expect(b.snapshot().files).toHaveLength(1);
  });

  it("the default id generator avoids reusing a prefix when re-wrapping the same doc", () => {
    const doc = new Y.Doc();
    const p1 = new CollabProject(doc);
    const id1 = p1.create("/a.typ", "a", human);
    // A second wrapper around the SAME doc (same clientID) must not reissue id1.
    const p2 = new CollabProject(doc);
    const id2 = p2.create("/b.typ", "b", human);
    expect(id2).not.toBe(id1);
    expect(p2.snapshot().files).toHaveLength(2);
  });
});

describe("CollabProject — sync + per-file attribution (slice 5)", () => {
  it("syncs the whole project (files, content, main) over a CollabConnection", () => {
    const net = new InMemoryNetwork();
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    const b = new CollabProject(new Y.Doc(), { newId: ids("b") });
    a.create("/main.typ", "= Title", human);
    a.create("/lib.typ", "#let x = 1", human);
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect(); // B's step1 → A replies step2 → B converges

    const files = b.snapshot().files;
    expect(files.map((f) => f.path)).toEqual(["/lib.typ", "/main.typ"]);
    expect(b.getFile(b.mainFileId()!)!.text).toBe("= Title");
    expect(b.mainFileId()).toBe(a.mainFileId());
    connA.destroy();
    connB.destroy();
  });

  it("attributes each file's spans to the originating peer (doc-global authors map)", () => {
    const net = new InMemoryNetwork();
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    const b = new CollabProject(new Y.Doc(), { newId: ids("b") });
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect();
    registerAuthor(a, human); // each peer registers its own identity (syncs)
    registerAuthor(b, agent);

    const id = a.create("/main.typ", "HELLO", human); // span 1 by A (human)
    b.transactFile(id, (t) => t.insert(t.length, "WORLD"), agent); // span 2 by B (agent)

    // Resolve on A using the per-file Y.Text + the doc-global authors map.
    const ranges = textAttributedRanges(a, a.fileText(id)!);
    expect(a.getFile(id)!.text).toBe("HELLOWORLD");
    expect(ranges.map((r) => r.author?.kind)).toEqual(["human", "agent"]);
    connA.destroy();
    connB.destroy();
  });
});

describe("CollabProject — binary files (#7 slice 7B)", () => {
  const asset = (hash: string, size = 10, mime = "image/png") =>
    ({ type: "binary" as const, hash, size, mime });

  it("creates a binary pointer, reflects its fields, and never sets main", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const textId = p.create("/main.typ", "= Doc", human);
    const binId = p.createBinary("/fig.png", asset("abc123", 2048, "image/png"), human);
    const b = p.getBinary(binId)!;
    expect(b).toMatchObject({ path: "/fig.png", hash: "abc123", size: 2048, mime: "image/png", deleted: false });
    // main stays the text file; createBinary must never claim it.
    expect(p.mainFileId()).toBe(textId);
    // binary files don't appear in the text snapshot.files
    expect(p.snapshot().files.map((f) => f.path)).toEqual(["/main.typ"]);
    expect(p.snapshot().binaryFiles!.map((f) => f.path)).toEqual(["/fig.png"]);
  });

  it("omits binaryFiles from the snapshot when there are none (byte-for-byte)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    p.create("/main.typ", "x", human);
    expect("binaryFiles" in p.snapshot()).toBe(false);
  });

  it("renames, tombstones, and restores a binary like a text file", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const id = p.createBinary("/a.png", asset("h1"), human);
    p.renameBinary(id, "/img/a.png", human);
    expect(p.getBinary(id)!.path).toBe("/img/a.png");
    p.deleteBinary(id, human);
    expect(p.getBinary(id)!.deleted).toBe(true);
    // like snapshot.files, a tombstoned binary stays in the snapshot (deleted=true);
    // binaryFiles is omitted only when the project NEVER had a binary.
    expect(p.snapshot().binaryFiles!.find((f) => f.fileId === id)!.deleted).toBe(true);
    p.restoreBinary(id, human);
    expect(p.getBinary(id)!.deleted).toBe(false);
  });

  it("flags a text↔binary path collision as a duplicate (compile-blocking)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    p.create("/clash.typ", "x", human);
    p.create("/main.typ", "y", human);
    p.createBinary("/clash.typ", asset("h2"), human);
    expect(p.duplicatePaths()).toEqual(["/clash.typ"]);
    // toProjectInput refuses to compile while the collision stands.
    expect(p.toProjectInput()).toBeNull();
    // a deleted binary no longer collides
    const dup = p.snapshot().binaryFiles!.find((f) => f.path === "/clash.typ")!;
    p.deleteBinary(dup.fileId, human);
    expect(p.duplicatePaths()).toEqual([]);
    expect(p.toProjectInput()).not.toBeNull();
  });

  it("never issues a text and binary file the same id across a reload", () => {
    const doc = new Y.Doc();
    const p = new CollabProject(doc); // default id gen (clientID-counter)
    const tId = p.create("/m.typ", "x", human);
    const bId = p.createBinary("/i.png", asset("h3"), human);
    expect(tId).not.toBe(bId);
    // re-wrap the SAME doc (simulates reload): the counter must clear BOTH maps.
    const p2 = new CollabProject(doc);
    const tId2 = p2.create("/n.typ", "y", human);
    const bId2 = p2.createBinary("/j.png", asset("h4"), human);
    expect(new Set([tId, bId, tId2, bId2]).size).toBe(4);
  });

  it("syncs binary pointers to a peer", () => {
    const a = new CollabProject(new Y.Doc(), { newId: ids("a") });
    const b = new CollabProject(new Y.Doc(), { newId: ids("b") });
    a.createBinary("/shared.png", asset("h5", 99, "image/png"), human);
    sync(a, b);
    const got = b.snapshot().binaryFiles!;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ path: "/shared.png", hash: "h5", size: 99 });
  });

  it("throws on binary ops against an unknown id", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    expect(() => p.renameBinary("nope", "/x.png", human)).toThrow(/unknown binary fileId/);
    expect(p.getBinary("nope")).toBeUndefined();
  });
});

describe("CollabProject — revision (M13 compile-key memo)", () => {
  it("is stable when nothing changes", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    p.create("/main.typ", "= Hello", human);
    const r = p.revision();
    expect(p.revision()).toBe(r); // a plain re-read (a cursor move) never advances it
  });

  it("advances on a text edit (the finding's case)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const id = p.create("/main.typ", "= Hello", human);
    const before = p.revision();
    p.fileText(id)!.insert(7, " world");
    expect(p.revision()).not.toBe(before);
  });

  it("advances on add / rename / delete / set-main (a superset of compile inputs)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const a = p.create("/main.typ", "x", human);
    let r = p.revision();
    const b = p.create("/two.typ", "y", human); // add
    expect(p.revision()).not.toBe(r);
    r = p.revision();
    p.rename(b, "/renamed.typ", human); // rename
    expect(p.revision()).not.toBe(r);
    r = p.revision();
    p.setMain(b, human); // set-main
    expect(p.revision()).not.toBe(r);
    r = p.revision();
    p.delete(a, human); // delete
    expect(p.revision()).not.toBe(r);
  });
});

describe("CollabProject — comments never reach the compile input (invariant)", () => {
  it("a comment-only mutation leaves toProjectInput + snapshot byte-identical", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const fileId = p.create("/main.typ", "hello world", human);
    const before = JSON.stringify(p.toProjectInput());
    const snapBefore = JSON.stringify(p.snapshot());

    // Open a thread + reply + resolve — the full comment write surface, all of which
    // live in the "comments" map, which is deliberately absent from the compile input.
    const ytext = p.fileText(fileId);
    if (!ytext) throw new Error("expected fileText for the created file");
    const id = createThread(
      p,
      { fileId, ytext, from: 0, to: 5, anchorText: "hello", body: "note" },
      human,
    );
    addMessage(p, id, "a reply", agent);
    setThreadStatus(p, id, "resolved", human);

    expect(JSON.stringify(p.toProjectInput())).toBe(before);
    expect(JSON.stringify(p.snapshot())).toBe(snapBefore);
    // (revision() DOES advance — comments share the doc — and that is harmless; we
    // deliberately do NOT pin it byte-stable here, per the design's invariant #5.)
    expect(getThreads(p)).toHaveLength(1);
  });
});
