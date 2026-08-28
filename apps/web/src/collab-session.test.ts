import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { CollabDocument, authorForClientID, attributedRanges, registerAuthor } from "@galley/collab";
import type { Author } from "@galley/shared";
import {
  applyAcceptedSource,
  applyAcceptedSourceAsAgent,
  readCollabConfig,
  createCollabSession,
  type DraftStore,
  type DraftStoreFactory,
} from "./collab-session.js";

const AGENT: Author = { kind: "agent", runId: "agent" };
const HUMAN: Author = { kind: "human", userId: "u" };

describe("applyAcceptedSource", () => {
  it("commits the accepted source (append case)", () => {
    const doc = new CollabDocument("base\n");
    applyAcceptedSource(doc, "base\nadded\n", AGENT);
    expect(doc.getSource()).toBe("base\nadded\n");
  });

  it("replaces only the differing middle span", () => {
    const doc = new CollabDocument("intro\nMIDDLE\ntail\n");
    applyAcceptedSource(doc, "intro\nNEWMID\ntail\n", AGENT);
    expect(doc.getSource()).toBe("intro\nNEWMID\ntail\n");
  });

  it("is a no-op when the target equals the current source", () => {
    const doc = new CollabDocument("same\n");
    let updates = 0;
    const off = doc.onUpdate(() => (updates += 1));
    applyAcceptedSource(doc, "same\n", AGENT);
    off();
    expect(updates).toBe(0);
  });

  it("tags the change with the agent author origin", () => {
    const doc = new CollabDocument("x");
    let origin: unknown;
    const off = doc.onUpdate((_u, o) => (origin = o));
    applyAcceptedSource(doc, "xy", AGENT);
    off();
    expect(origin).toBe("agent:agent");
  });

  it("does not clobber a concurrent disjoint edit (the whole point of a diff)", () => {
    const a = new CollabDocument("intro\nMIDDLE\ntail\n");
    const b = new CollabDocument();
    b.applyUpdate(a.encodeState());

    applyAcceptedSource(a, "intro\nNEWMID\ntail\n", AGENT); // agent rewrites the middle on A
    b.transact((t) => t.insert(t.length, "extra\n"), HUMAN); // human appends on B

    a.applyUpdate(b.encodeStateSince(a.stateVector()));
    b.applyUpdate(a.encodeStateSince(b.stateVector()));

    expect(a.getSource()).toBe(b.getSource());
    expect(a.getSource()).toContain("NEWMID");
    expect(a.getSource()).toContain("extra");
  });
});

describe("createCollabSession local-draft persistence", () => {
  const LOCAL = { enabled: true, syncUrl: undefined, room: undefined };

  /** A fake DraftStore that optionally preloads a "persisted draft" into the doc. */
  function fakeStore(preload?: string): {
    factory: DraftStoreFactory;
    destroyed: () => boolean;
    dbName: () => string | undefined;
  } {
    let destroyed = false;
    let name: string | undefined;
    const factory: DraftStoreFactory = (dbName: string, doc: Y.Doc): DraftStore => {
      name = dbName;
      if (preload) doc.getText("source").insert(0, preload);
      return {
        whenSynced: Promise.resolve(),
        destroy() {
          destroyed = true;
        },
      };
    };
    return { factory, destroyed: () => destroyed, dbName: () => name };
  }

  it("seeds the initial content after the store has synced (fresh draft)", async () => {
    const store = fakeStore();
    const session = createCollabSession("SEED\n", LOCAL, { draftStore: store.factory });
    await session.whenReady;
    expect(session.doc.getSource()).toBe("SEED\n");
    session.destroy();
  });

  it("restores a persisted draft and does NOT duplicate it with the seed", async () => {
    const store = fakeStore("RESTORED DRAFT\n");
    const session = createCollabSession("SEED\n", LOCAL, { draftStore: store.factory });
    await session.whenReady;
    expect(session.doc.getSource()).toBe("RESTORED DRAFT\n");
    session.destroy();
  });

  it("registers this peer's author AFTER seeding, so the seed survives and spans attribute", async () => {
    const session = createCollabSession("SEED\n", LOCAL, { draftStore: fakeStore().factory });
    await session.whenReady;
    expect(session.doc.getSource()).toBe("SEED\n"); // registration did not suppress the seed
    const self = authorForClientID(session.doc, session.doc.doc.clientID);
    expect(self?.kind).toBe("human");
    // The seeded span resolves to this peer's human author.
    expect(attributedRanges(session.doc)[0]?.author?.kind).toBe("human");
    session.destroy();
  });

  it("degrades to an in-memory seed when the draft store fails to load", async () => {
    // Persistence unavailable (e.g. IndexedDB blocked): whenReady must still
    // resolve and the doc must still be seeded so the editor is never blank.
    const factory: DraftStoreFactory = () => ({
      whenSynced: Promise.reject(new Error("indexeddb unavailable")),
      destroy() {},
    });
    const session = createCollabSession("SEED\n", LOCAL, { draftStore: factory });
    await session.whenReady;
    expect(session.doc.getSource()).toBe("SEED\n");
    session.destroy();
  });

  it("flags whenPersisted as REJECTED when the draft store fails to load (C1 at-risk signal)", async () => {
    // The in-memory degrade keeps the editor usable, but the save state must stop
    // claiming "Saved" — whenPersisted carries the failure so useSaveState can show
    // "Not saved". whenReady still resolves (seeding proceeds) — the two are distinct.
    const factory: DraftStoreFactory = () => ({
      whenSynced: Promise.reject(new Error("indexeddb unavailable")),
      destroy() {},
    });
    const session = createCollabSession("SEED\n", LOCAL, { draftStore: factory });
    await session.whenReady;
    await expect(session.whenPersisted!).rejects.toThrow(/indexeddb/i);
    session.destroy();
  });

  it("resolves whenPersisted when the draft store loads cleanly (no false at-risk)", async () => {
    const session = createCollabSession("SEED\n", LOCAL, { draftStore: fakeStore().factory });
    await expect(session.whenPersisted!).resolves.toBeUndefined();
    session.destroy();
  });

  it("keys the IndexedDB store by a versioned, room-scoped name", async () => {
    const store = fakeStore();
    const session = createCollabSession(
      "SEED\n",
      { enabled: true, syncUrl: undefined, room: "paper7" },
      { draftStore: store.factory },
    );
    await session.whenReady;
    expect(store.dbName()).toBe("galley-local-draft-v1-paper7");
    session.destroy();
  });

  it("destroys the persistence store on session destroy (without wiping data)", async () => {
    const store = fakeStore();
    const session = createCollabSession("SEED\n", LOCAL, { draftStore: store.factory });
    await session.whenReady;
    session.destroy();
    expect(store.destroyed()).toBe(true);
  });

  it("does NOT persist in connected mode (server is the authority)", async () => {
    const store = fakeStore();
    // A never-opening fake socket so connect() buffers and nothing networks.
    const socket = {
      readyState: 0,
      binaryType: "",
      send() {},
      close() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const session = createCollabSession(
      "SEED\n",
      { enabled: true, syncUrl: "ws://localhost:1", room: "r" },
      { draftStore: store.factory, socketFactory: () => socket },
    );
    await session.whenReady;
    expect(store.dbName()).toBeUndefined();
    session.destroy();
  });
});

describe("applyAcceptedSourceAsAgent", () => {
  it("commits the accepted source and attributes the new span to the agent", () => {
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "intro\n"), HUMAN);
    registerAuthor(doc, HUMAN);

    applyAcceptedSourceAsAgent(doc, "intro\nadded by agent\n", "run-1");

    expect(doc.getSource()).toBe("intro\nadded by agent\n");
    // The original intro stays human; the appended span is the agent's.
    const ranges = attributedRanges(doc);
    expect(ranges[0]?.author).toEqual(HUMAN);
    expect(ranges[ranges.length - 1]?.author).toEqual({ kind: "agent", runId: "run-1" });
  });

  it("is a no-op when the target already equals the current source", () => {
    const doc = new CollabDocument("same\n");
    registerAuthor(doc, HUMAN);
    let updates = 0;
    const off = doc.onUpdate(() => (updates += 1));
    applyAcceptedSourceAsAgent(doc, "same\n", "run-1");
    off();
    expect(updates).toBe(0);
  });

  it("does not clobber a concurrent disjoint human edit (no-clobber via minimal diff)", () => {
    const a = new CollabDocument("intro\nMIDDLE\ntail\n");
    registerAuthor(a, HUMAN);
    const b = new CollabDocument();
    b.applyUpdate(a.encodeState());

    applyAcceptedSourceAsAgent(a, "intro\nNEWMID\ntail\n", "run-2"); // agent rewrites middle on A
    b.transact((t) => t.insert(t.length, "extra\n"), HUMAN); // human appends on B

    a.applyUpdate(b.encodeStateSince(a.stateVector()));
    b.applyUpdate(a.encodeStateSince(b.stateVector()));

    expect(a.getSource()).toBe(b.getSource());
    expect(a.getSource()).toContain("NEWMID");
    expect(a.getSource()).toContain("extra");
  });
});

describe("readCollabConfig", () => {
  it("is off by default and parses the flag + sync params", () => {
    // `readCollabConfig` reads an UNTRUSTED join URL, so an absent `?role=` fails
    // closed to `viewer` (SEC). The local-owner editor default is sourced
    // elsewhere (ProjectApp's `sessionRole`), never from this URL parse.
    expect(readCollabConfig("")).toEqual({
      enabled: false,
      project: false,
      syncUrl: undefined,
      room: undefined,
      role: "viewer",
    });
    expect(readCollabConfig("?collab=1")).toEqual({
      enabled: true,
      project: false,
      syncUrl: undefined,
      room: undefined,
      role: "viewer",
    });
    expect(readCollabConfig("?collab=1&sync=ws://h:1/&room=doc7")).toEqual({
      enabled: true,
      project: false,
      syncUrl: "ws://h:1/",
      room: "doc7",
      role: "viewer",
    });
  });

  it("parses the ?project=1 multi-file flag", () => {
    expect(readCollabConfig("?project=1").project).toBe(true);
    expect(readCollabConfig("?collab=1").project).toBe(false);
  });

  it("decodes the B19 share role from ?role=, FAILING CLOSED to viewer (SEC)", () => {
    // A read-only join link.
    expect(readCollabConfig("?project=1&collab=1&room=r&role=viewer").role).toBe("viewer");
    // An EXPLICIT editor link is the only way a join URL grants edit.
    expect(readCollabConfig("?project=1&collab=1&room=r&role=editor").role).toBe("editor");
    // Absent / empty / forged → fail closed to the least-privilege viewer. A
    // pre-role link, or a link with `?role=owner`, can NEVER boot as an editor.
    expect(readCollabConfig("?project=1&collab=1&room=r").role).toBe("viewer");
    expect(readCollabConfig("").role).toBe("viewer");
    expect(readCollabConfig("?role=").role).toBe("viewer");
    expect(readCollabConfig("?role=owner").role).toBe("viewer");
  });
});
