import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import {
  CollabProject,
  authorForClientID,
  distinctAuthors,
  registerAuthor,
  textAttributedRanges,
  BLOB_WANTS_FIELD,
  type SeedFile,
  type BinaryFileSnapshot,
  type ProjectSnapshot,
} from "@galley/collab";
import type { Author, ProjectId, Version, VersionedFile, VersionStore } from "@galley/shared";
import {
  applyAcceptedFileAsAgent,
  applyAcceptedFileSetAsAgent,
  connectProjectSession,
  createProjectSession,
  ensureAuthenticatedBlobChannel,
  setSessionDisplayName,
  wireBlobSync,
} from "./project-session.js";
import { buildBlobTerminalAuth } from "@galley/collab";
import { PersistentBlobStore, InMemoryBlobBackend } from "./idb-blob-store.js";
import type { DraftStore, DraftStoreFactory } from "./collab-session.js";
import { DEMO_HISTORY } from "./demo/einstein-1905.js";

const PRE: Author = { kind: "human", userId: "pre" };
const HUMAN: Author = { kind: "human", userId: "u" };
const LOCAL = { enabled: true, project: true, syncUrl: undefined, room: undefined };

const SEED: SeedFile[] = [
  { path: "/main.typ", text: '#import "/lib.typ": x\n#x' },
  { path: "/lib.typ", text: "#let x = [hi]" },
];

/** A fake DraftStore that can preload a "persisted project" into the doc. */
function fakeStore(preload?: { files: SeedFile[]; main: string }): {
  factory: DraftStoreFactory;
  destroyed: () => boolean;
  dbName: () => string | undefined;
} {
  let destroyed = false;
  let name: string | undefined;
  const factory: DraftStoreFactory = (dbName: string, doc: Y.Doc): DraftStore => {
    name = dbName;
    if (preload) new CollabProject(doc).seedIfPristine(preload.files, preload.main, PRE);
    return {
      whenSynced: Promise.resolve(),
      destroy() {
        destroyed = true;
      },
    };
  };
  return { factory, destroyed: () => destroyed, dbName: () => name };
}

/**
 * A recording fake VersionStore (#20.2): captures `createVersion` calls so the
 * tests can assert WHEN the demo history gets seeded (true first seed only) and
 * exactly what is written. Injected everywhere so the Node gate never touches
 * the default IndexedDB-backed store.
 */
function fakeVersions(opts: { failList?: boolean; existing?: number } = {}): {
  store: VersionStore;
  created: { projectId: ProjectId; name: string; tree: VersionedFile[] }[];
  listed: () => number;
} {
  const created: { projectId: ProjectId; name: string; tree: VersionedFile[] }[] = [];
  let listCalls = 0;
  const store: VersionStore = {
    createVersion(projectId, input, tree): Promise<Version> {
      created.push({ projectId, name: input.name, tree });
      return Promise.resolve({ id: `v${created.length}`, projectId, name: input.name });
    },
    listVersions(projectId): Promise<Version[]> {
      listCalls += 1;
      if (opts.failList) return Promise.reject(new Error("idb gone"));
      return Promise.resolve(
        Array.from({ length: opts.existing ?? 0 }, (_, i) => ({
          id: `pre${i}`,
          projectId,
          name: `pre-existing ${i}`,
        })),
      );
    },
    getVersionTree: () => Promise.resolve(null),
  };
  return { store, created, listed: () => listCalls };
}

describe("createProjectSession (local-draft persistence)", () => {
  it("seeds the initial files after the store has synced (fresh project)", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, { draftStore: fakeStore().factory, versionStore: fakeVersions().store });
    await session.whenReady;
    const input = session.project.toProjectInput()!;
    expect(input.main).toBe("/main.typ");
    expect(input.files.map((f) => f.path)).toEqual(["/lib.typ", "/main.typ"]);
    session.destroy();
  });

  it("restores a persisted project and does NOT re-seed (no duplication)", async () => {
    const store = fakeStore({ files: [{ path: "/restored.typ", text: "R" }], main: "/restored.typ" });
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: store.factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    const files = session.project.snapshot().files;
    expect(files.map((f) => f.path)).toEqual(["/restored.typ"]); // seed skipped
    session.destroy();
  });

  it("registers this peer's author AFTER seeding, so spans attribute and the seed survives", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, { draftStore: fakeStore().factory, versionStore: fakeVersions().store });
    await session.whenReady;
    const mainId = session.project.mainFileId()!;
    expect(session.project.getFile(mainId)!.path).toBe("/main.typ"); // seed survived registration
    const self = authorForClientID(session.project, session.project.doc.clientID);
    expect(self?.kind).toBe("human");
    const ranges = textAttributedRanges(session.project, session.project.fileText(mainId)!);
    expect(ranges[0]?.author?.kind).toBe("human");
    session.destroy();
  });

  it("degrades to an in-memory seed when the draft store fails to load", async () => {
    const factory: DraftStoreFactory = () => ({
      whenSynced: Promise.reject(new Error("indexeddb unavailable")),
      destroy() {},
    });
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    expect(session.project.toProjectInput()!.files).toHaveLength(2);
    session.destroy();
  });

  it("flags whenPersisted as REJECTED when the local draft store fails to load (C1 at-risk signal)", async () => {
    const factory: DraftStoreFactory = () => ({
      whenSynced: Promise.reject(new Error("indexeddb unavailable")),
      destroy() {},
    });
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    await expect(session.whenPersisted!).rejects.toThrow(/indexeddb/i);
    session.destroy();
  });

  it("resolves whenPersisted when the local draft store loads cleanly (no false at-risk)", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await expect(session.whenPersisted!).resolves.toBeUndefined();
    session.destroy();
  });

  it("keys the IndexedDB store by a versioned, room-scoped name", async () => {
    const store = fakeStore();
    const session = createProjectSession(
      SEED,
      "/main.typ",
      { enabled: true, project: true, syncUrl: undefined, room: "paper7" },
      { draftStore: store.factory, versionStore: fakeVersions().store },
    );
    await session.whenReady;
    expect(store.dbName()).toBe("galley-local-project-v1-paper7");
    session.destroy();
  });

  it("destroys the persistence store on session destroy (without wiping data)", async () => {
    const store = fakeStore();
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: store.factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    session.destroy();
    expect(store.destroyed()).toBe(true);
  });

  it("keeps a room-scoped local cache in connected mode (#2a joiner durability)", async () => {
    const store = fakeStore();
    const fakeSocket = () => ({
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    });
    const session = createProjectSession(
      SEED,
      "/main.typ",
      { enabled: true, project: true, syncUrl: "ws://localhost:1", room: "r" },
      { draftStore: store.factory, socketFactory: fakeSocket as never },
    );
    await session.whenReady;
    // The joiner now retains its OWN copy in a room-scoped, connected-namespaced db
    // (distinct from the LOCAL draft namespace), so a relay/host blip can't wipe it.
    expect(store.dbName()).toBe("galley-connected-project-v1-r");
    expect(session.connection).toBeDefined();
    // C1 scope: a connected joiner is NOT flagged at-risk on a cache hiccup — the
    // relay is the authority there, so the persistence-failure signal is local-only.
    expect(session.whenPersisted).toBeUndefined();
    session.destroy();
    // Detached on destroy, but the data is NOT deleted (replica survives sessions).
    expect(store.destroyed()).toBe(true);
  });

  it("does NOT seed the demo history in connected mode (cache is a pure replica)", async () => {
    const store = fakeStore();
    const versions = fakeVersions();
    const fakeSocket = () => ({
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    });
    const session = createProjectSession(
      SEED,
      "/main.typ",
      { enabled: true, project: true, syncUrl: "ws://localhost:1", room: "r" },
      {
        draftStore: store.factory,
        socketFactory: fakeSocket as never,
        versionStore: versions.store,
        demoHistory: true,
      },
    );
    await session.whenReady;
    // No seedIfPristine, no demo-history seeding in connected mode.
    expect(versions.created).toHaveLength(0);
    session.destroy();
  });
});

describe("createProjectSession demo-history seeding (project-model redesign §2)", () => {
  it("a TRUE first seed WITH demoHistory writes the four 1905 versions (oldest first, names verbatim) under the room id", async () => {
    const versions = fakeVersions();
    const session = createProjectSession(
      SEED,
      "/main.typ",
      { enabled: true, project: true, syncUrl: undefined, room: "proj-x" },
      { draftStore: fakeStore().factory, versionStore: versions.store, demoHistory: true },
    );
    await session.whenReady;
    expect(versions.created.map((c) => c.name)).toEqual(DEMO_HISTORY.map((h) => h.name));
    expect(versions.created.every((c) => c.projectId === "proj-x")).toBe(true);
    session.destroy();
  });

  it("a fresh seed WITHOUT demoHistory seeds ZERO demo versions (blank/import default)", async () => {
    // The core §2 change: a blank/import project is a true first seed but must
    // NOT inherit the Einstein 1905 timeline. The store is not even consulted.
    const versions = fakeVersions();
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: versions.store,
    });
    await session.whenReady;
    expect(versions.created).toHaveLength(0);
    expect(versions.listed()).toBe(0);
    session.destroy();
  });

  it("defaults the projectId to \"default\" when the config has no room (ProjectApp parity)", async () => {
    const versions = fakeVersions();
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: versions.store,
      demoHistory: true,
    });
    await session.whenReady;
    expect(versions.created).toHaveLength(4);
    expect(versions.created[0]!.projectId).toBe("default");
    session.destroy();
  });

  it("a RESTORED project with ZERO saved versions is NOT seeded (the empty list is no signal)", async () => {
    // The Architect-ruled guard: an existing project may legitimately have no
    // versions; only the fresh-seed signal (seedIfPristine returning non-null)
    // may trigger history seeding — so the store must not even be consulted,
    // even with demoHistory requested.
    const versions = fakeVersions();
    const store = fakeStore({ files: [{ path: "/restored.typ", text: "R" }], main: "/restored.typ" });
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: store.factory,
      versionStore: versions.store,
      demoHistory: true,
    });
    await session.whenReady;
    expect(versions.created).toHaveLength(0);
    expect(versions.listed()).toBe(0); // never consulted at all
    session.destroy();
  });

  it("a misfired signal still seeds nothing when versions already exist (exactly-once)", async () => {
    const versions = fakeVersions({ existing: 1 });
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: versions.store,
      demoHistory: true,
    });
    await session.whenReady;
    expect(versions.created).toHaveLength(0);
    session.destroy();
  });

  it("CONNECTED mode never seeds history (server is the authority; no local seed)", async () => {
    const versions = fakeVersions();
    const fakeSocket = () => ({
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    });
    const session = createProjectSession(
      SEED,
      "/main.typ",
      { enabled: true, project: true, syncUrl: "ws://localhost:1", room: "r" },
      {
        draftStore: fakeStore().factory,
        versionStore: versions.store,
        socketFactory: fakeSocket as never,
        demoHistory: true,
      },
    );
    await session.whenReady;
    expect(versions.created).toHaveLength(0);
    expect(versions.listed()).toBe(0);
    session.destroy();
  });

  it("a failing version store does not break boot (fail-soft: whenReady resolves, project usable)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const versions = fakeVersions({ failList: true });
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: versions.store,
      demoHistory: true,
    });
    await session.whenReady; // must resolve despite the store failure
    expect(session.project.toProjectInput()!.files).toHaveLength(2); // seed intact
    expect(versions.created).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    session.destroy();
  });
});

describe("createProjectSession — hydration-gated blob GC (wave-13)", () => {
  const fakeSocket = () =>
    ({
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    }) as never;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const seedBlob = async (store: PersistentBlobStore, ...b: number[]): Promise<string> =>
    (await store.put(new Uint8Array(b))).hash;

  it("LOCAL: sweeps orphan blobs AFTER whenReady (the text-only seed references none)", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const orphan = await seedBlob(store, 1, 2, 3);
    expect(await store.has(orphan)).toBe(true);
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
      blobStore: store,
    });
    await session.whenReady;
    await flush(); // let the post-ready sweep settle
    expect(await store.has(orphan)).toBe(false); // reclaimed once hydrated
    session.destroy();
  });

  it("LOCAL: does NOT sweep before whenReady resolves (a slow persistence load holds GC off)", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const orphan = await seedBlob(store, 4, 5, 6);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slowFactory: DraftStoreFactory = () => ({ whenSynced: gate, destroy() {} });
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: slowFactory,
      versionStore: fakeVersions().store,
      blobStore: store,
    });
    await Promise.resolve();
    expect(await store.has(orphan)).toBe(true); // persistence unloaded → no sweep yet
    release();
    await session.whenReady;
    await flush();
    expect(await store.has(orphan)).toBe(false); // swept only after hydration
    session.destroy();
  });

  it("CONNECTED: NEVER runs destructive GC (Security round #4 — peer-writable doc, no authoritative snapshot)", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const held = await seedBlob(store, 7, 8, 9);
    const session = createProjectSession(
      SEED,
      "/main.typ",
      { enabled: true, project: true, syncUrl: "ws://localhost:1", room: "r" },
      {
        draftStore: fakeStore().factory,
        socketFactory: fakeSocket,
        blobStore: store,
        blobSocketFactory: fakeSocket,
      },
    );
    await session.whenReady;
    await flush();
    // A connected session skips the destructive sweep entirely (never gated on sync),
    // so a blob unreferenced by the still-hydrating doc is RETAINED, not deleted.
    expect(await store.has(held)).toBe(true);
    session.destroy();
  });
});

describe("connectProjectSession (live Share upgrade, #14-C)", () => {
  const fakeSocket = () =>
    ({
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    }) as never;

  it("exposes the local author and upgrades a LOCAL session to a connection in place", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, { draftStore: fakeStore().factory, versionStore: fakeVersions().store });
    await session.whenReady;
    expect(session.author.kind).toBe("human");
    expect(session.connection).toBeUndefined();

    // The content-bearing project keeps its seeded files after the upgrade.
    const before = session.project.snapshot().files.map((f) => f.path);
    const conn = connectProjectSession(session, "ws://localhost:1234", "share-x", {
      socketFactory: fakeSocket,
    });
    expect(conn).toBeDefined();
    expect(session.connection).toBe(conn);
    expect(session.project.snapshot().files.map((f) => f.path)).toEqual(before);
    session.destroy();
  });

  it("reuses the session author (write-once) so it does not throw and attribution survives", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, { draftStore: fakeStore().factory, versionStore: fakeVersions().store });
    await session.whenReady;
    const selfBefore = authorForClientID(session.project, session.project.doc.clientID);
    expect(() =>
      connectProjectSession(session, "ws://localhost:1234", "share-y", { socketFactory: fakeSocket }),
    ).not.toThrow();
    expect(authorForClientID(session.project, session.project.doc.clientID)).toEqual(selfBefore);
    session.destroy();
  });

  it("is idempotent — a second call returns the same connection (no duplicate socket)", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, { draftStore: fakeStore().factory, versionStore: fakeVersions().store });
    await session.whenReady;
    const first = connectProjectSession(session, "ws://localhost:1234", "share-z", {
      socketFactory: fakeSocket,
    });
    const second = connectProjectSession(session, "ws://localhost:1234", "share-z2", {
      socketFactory: fakeSocket,
    });
    expect(second).toBe(first);
    session.destroy();
  });
});

describe("ensureAuthenticatedBlobChannel (A1 §1 channel-auth guarantee)", () => {
  const fakeSocket = () =>
    ({
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    }) as never;
  const KEY = new Uint8Array(32).map((_, i) => (i * 3) & 0xff);
  const scopeOf = (grantId: string) => ({
    grantId,
    controlRoom: "c",
    syncUrl: "ws://x",
    projectId: "p",
    shareRoom: "share-1",
  });
  const scopeIdOf = (grantId: string): string =>
    JSON.stringify(["blob-terminal-scope", grantId, "c", "ws://x", "p", "share-1"]);
  // Build authenticated blobOpts for a given grantId — the scope identity differs by
  // grantId, simulating a re-consent that minted a fresh grant.
  const authOpts = (grantId = "g") => {
    const auth = buildBlobTerminalAuth(KEY, scopeOf(grantId));
    return {
      store: new PersistentBlobStore(new InMemoryBlobBackend()),
      socketFactory: fakeSocket,
      terminalSigner: auth.terminalSigner,
      terminalVerifier: auth.terminalVerifier,
      terminalScopeId: scopeIdOf(grantId),
    };
  };

  it("UPGRADES an advisory channel (plain-Share-first) to an AUTHENTICATED one", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    // A plain Share opened the channel with {store}-only (advisory) opts.
    connectProjectSession(session, "ws://localhost:1234", "share-1", { socketFactory: fakeSocket }, "editor", {
      store: new PersistentBlobStore(new InMemoryBlobBackend()),
      socketFactory: fakeSocket,
    });
    expect(session.blobChannel?.authenticated).toBe(false);
    const advisory = session.blobChannel;

    // The agent reuse path guarantees an authenticated channel for its scope.
    const upgraded = ensureAuthenticatedBlobChannel(session, "ws://localhost:1234", "share-1", authOpts());
    expect(upgraded).toBeDefined();
    expect(upgraded!.authenticated).toBe(true);
    // The advisory channel was REPLACED (a new instance).
    expect(session.blobChannel).not.toBe(advisory);
    expect(session.blobChannel!.authenticated).toBe(true);
    session.destroy();
  });

  it("is a NO-OP when the channel is already authenticated FOR THE SAME SCOPE", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    connectProjectSession(session, "ws://localhost:1234", "share-1", { socketFactory: fakeSocket }, "editor", authOpts("g"));
    const authed = session.blobChannel;
    expect(authed?.authenticated).toBe(true);
    expect(authed?.terminalScopeId).toBe(scopeIdOf("g"));
    // Same grantId/scope → untouched.
    const same = ensureAuthenticatedBlobChannel(session, "ws://localhost:1234", "share-1", authOpts("g"));
    expect(same).toBe(authed);
    session.destroy();
  });

  it("RECREATES an authenticated channel built for a DIFFERENT scope (re-consent → new grantId)", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    // Connected with the OLD grant's auth.
    connectProjectSession(session, "ws://localhost:1234", "share-1", { socketFactory: fakeSocket }, "editor", authOpts("old-grant"));
    const oldChannel = session.blobChannel;
    expect(oldChannel?.terminalScopeId).toBe(scopeIdOf("old-grant"));

    // A revoke + re-consent minted a NEW grantId — the guarantee must RECREATE the
    // channel with the new-scope auth (a stale verifier would reject the new
    // kernel's legitimately-signed COMPLETE).
    const upgraded = ensureAuthenticatedBlobChannel(
      session,
      "ws://localhost:1234",
      "share-1",
      authOpts("new-grant"),
    );
    expect(upgraded).not.toBe(oldChannel); // recreated
    expect(upgraded!.authenticated).toBe(true);
    expect(upgraded!.terminalScopeId).toBe(scopeIdOf("new-grant"));
    expect(session.blobChannel).toBe(upgraded);

    // The new channel's verifier ACCEPTS a COMPLETE signed under the NEW scope and
    // REJECTS one signed under the OLD scope (the whole point of the recreate).
    const newKernel = buildBlobTerminalAuth(KEY, scopeOf("new-grant"));
    const oldKernel = buildBlobTerminalAuth(KEY, scopeOf("old-grant"));
    const newAuth = buildBlobTerminalAuth(KEY, scopeOf("new-grant"));
    const hash = "a".repeat(64);
    const newMac = await newKernel.terminalSigner("complete", "t", hash, 3, null);
    const oldMac = await oldKernel.terminalSigner("complete", "t", hash, 3, null);
    expect(await newAuth.terminalVerifier("complete", "t", hash, 3, null, newMac)).toBe(true);
    expect(await newAuth.terminalVerifier("complete", "t", hash, 3, null, oldMac)).toBe(false);
    session.destroy();
  });

  it("CREATES an authenticated channel when none exists", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    connectProjectSession(session, "ws://localhost:1234", "share-1", { socketFactory: fakeSocket }, "editor");
    expect(session.blobChannel).toBeUndefined();
    const ch = ensureAuthenticatedBlobChannel(session, "ws://localhost:1234", "share-1", authOpts());
    expect(ch?.authenticated).toBe(true);
    expect(session.blobChannel?.authenticated).toBe(true);
    session.destroy();
  });

  it("does NOT upgrade when the opts carry NO verifier (no agent session)", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    connectProjectSession(session, "ws://localhost:1234", "share-1", { socketFactory: fakeSocket }, "editor", {
      store: new PersistentBlobStore(new InMemoryBlobBackend()),
      socketFactory: fakeSocket,
    });
    const advisory = session.blobChannel;
    // No verifier in opts → cannot authenticate → channel left as-is.
    const result = ensureAuthenticatedBlobChannel(session, "ws://localhost:1234", "share-1", {
      store: new PersistentBlobStore(new InMemoryBlobBackend()),
      socketFactory: fakeSocket,
    });
    expect(result).toBe(advisory);
    expect(session.blobChannel).toBe(advisory);
    session.destroy();
  });
});

describe("setSessionDisplayName (host names themselves, #19.4 host counterpart)", () => {
  const fakeSocket = () =>
    ({
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    }) as never;

  it("names the in-memory author so a LATER share carries the name", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    expect(session.author.kind === "human" && session.author.name).toBeFalsy();

    setSessionDisplayName(session, "  Ada Lovelace  ");
    expect(session.author).toMatchObject({ kind: "human", name: "Ada Lovelace" });

    // The share built AFTER naming advertises the name on presence.
    const conn = connectProjectSession(session, "ws://localhost:1234", "share-name", {
      socketFactory: fakeSocket,
    });
    const state = conn.awareness.getLocalState() as {
      author: { name?: string };
      user: { name?: string };
    };
    expect(state.author.name).toBe("Ada Lovelace");
    expect(state.user.name).toBe("Ada Lovelace");
    session.destroy();
  });

  it("live-updates presence when ALREADY connected, preserving role + cursor color", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    const conn = connectProjectSession(
      session,
      "ws://localhost:1234",
      "share-live",
      { socketFactory: fakeSocket },
      "editor",
    );
    const before = conn.awareness.getLocalState() as { user: { color?: string }; role?: string };
    const colorBefore = before.user.color;

    setSessionDisplayName(session, "Grace");
    const after = conn.awareness.getLocalState() as {
      author: { name?: string };
      user: { name?: string; color?: string };
      role?: string;
    };
    expect(after.author.name).toBe("Grace");
    expect(after.user.name).toBe("Grace");
    expect(after.user.color).toBe(colorBefore); // cursor color preserved
    expect(after.role).toBe("editor"); // share role preserved
    session.destroy();
  });

  it("is a no-op for a blank name", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    setSessionDisplayName(session, "   ");
    expect(session.author.kind === "human" && session.author.name).toBeFalsy();
    session.destroy();
  });

  it("renames this peer in the attribution map, not just live presence (display-name freeze fix)", async () => {
    const session = createProjectSession(SEED, "/main.typ", LOCAL, {
      draftStore: fakeStore().factory,
      versionStore: fakeVersions().store,
    });
    await session.whenReady;
    // The seed registered this peer with no display name yet.
    const userId = session.author.kind === "human" ? session.author.userId : "";
    expect(distinctAuthors(session.project)).toEqual([{ kind: "human", userId }]);

    setSessionDisplayName(session, "  Ada Lovelace  ");
    // The doc-global authors map now carries the name — so spans this peer wrote
    // (and future snapshots' contributor labels) show it, not just the roster.
    expect(distinctAuthors(session.project)).toEqual([
      { kind: "human", userId, name: "Ada Lovelace" },
    ]);
    session.destroy();
  });
});

describe("applyAcceptedFileAsAgent", () => {
  it("applies the accepted text to the file and attributes the new span to the agent", () => {
    const project = new CollabProject(new Y.Doc());
    registerAuthor(project, HUMAN);
    const id = project.create("/main.typ", "Hello", HUMAN);

    applyAcceptedFileAsAgent(project, id, "Hello world", "run1");

    expect(project.getFile(id)!.text).toBe("Hello world");
    const ranges = textAttributedRanges(project, project.fileText(id)!);
    expect(ranges[0]?.author?.kind).toBe("human"); // "Hello" stays human
    const agentRange = ranges.find((r) => r.author?.kind === "agent");
    expect(agentRange).toBeDefined();
    expect("Hello world".slice(agentRange!.from, agentRange!.to)).toBe(" world");
  });

  it("is a no-op when the target equals the current text", () => {
    const project = new CollabProject(new Y.Doc());
    registerAuthor(project, HUMAN);
    const id = project.create("/main.typ", "same", HUMAN);
    applyAcceptedFileAsAgent(project, id, "same", "run1");
    const ranges = textAttributedRanges(project, project.fileText(id)!);
    expect(ranges.every((r) => r.author?.kind === "human")).toBe(true);
  });

  it("only the agent's clientID is registered as the agent (human spans unaffected)", () => {
    const project = new CollabProject(new Y.Doc());
    registerAuthor(project, HUMAN);
    const id = project.create("/main.typ", "abc", HUMAN);
    applyAcceptedFileAsAgent(project, id, "abcXYZ", "run9");
    // The human peer's own clientID still resolves to the human.
    expect(authorForClientID(project, project.doc.clientID)?.kind).toBe("human");
  });
});

describe("applyAcceptedFileSetAsAgent (atomic multi-file Accept)", () => {
  it("creates new files AND edits existing ones in one merged update; new content attributes to the agent", () => {
    const project = new CollabProject(new Y.Doc());
    registerAuthor(project, HUMAN);
    const mainId = project.create("/main.typ", "= Title\nbody\n", HUMAN);

    let updates = 0;
    project.doc.on("update", () => (updates += 1));
    applyAcceptedFileSetAsAgent(
      project,
      {
        creates: [{ path: "/chapters/intro.typ", text: "= Intro\nHi.\n" }],
        edits: [{ fileId: mainId, source: "= Title\nbody\nmore\n" }],
      },
      "mcp",
    );

    // The whole set landed as ONE merged update (atomic from the live doc's view).
    expect(updates).toBe(1);
    const files = project.snapshot().files;
    expect(files.find((f) => f.path === "/chapters/intro.typ")?.text).toBe("= Intro\nHi.\n");
    expect(files.find((f) => f.path === "/main.typ")?.text).toBe("= Title\nbody\nmore\n");
    // The created file's body attributes to the agent (ADR-0012).
    const intro = files.find((f) => f.path === "/chapters/intro.typ")!;
    const ranges = textAttributedRanges(project, project.fileText(intro.fileId)!);
    expect(ranges.some((r) => r.author?.kind === "agent")).toBe(true);
  });

  it("an empty plan is a no-op (no update, no files)", () => {
    const project = new CollabProject(new Y.Doc());
    registerAuthor(project, HUMAN);
    project.create("/main.typ", "x\n", HUMAN);
    let updates = 0;
    project.doc.on("update", () => (updates += 1));
    applyAcceptedFileSetAsAgent(project, { creates: [], edits: [] }, "mcp");
    expect(updates).toBe(0);
    expect(project.snapshot().files).toHaveLength(1);
  });

  it("renames a file (path moves, text preserved) and soft-deletes another, in one merged update", () => {
    const project = new CollabProject(new Y.Doc());
    registerAuthor(project, HUMAN);
    const mainId = project.create("/main.typ", "= Title\nbody\n", HUMAN);
    const oldId = project.create("/old.typ", "old\n", HUMAN);

    let updates = 0;
    project.doc.on("update", () => (updates += 1));
    applyAcceptedFileSetAsAgent(
      project,
      {
        creates: [],
        edits: [],
        renames: [{ fileId: mainId, newPath: "/paper.typ" }],
        deletes: [{ fileId: oldId }],
      },
      "mcp",
    );

    // One atomic update from the live doc's view.
    expect(updates).toBe(1);
    const files = project.snapshot().files;
    // Rename is metadata-only: same fileId, new path, text intact.
    expect(files.find((f) => f.fileId === mainId)?.path).toBe("/paper.typ");
    expect(files.find((f) => f.fileId === mainId)?.text).toBe("= Title\nbody\n");
    // Delete is a recoverable soft-delete (the flag, never a CRDT destroy).
    expect(files.find((f) => f.fileId === oldId)?.deleted).toBe(true);
  });

  it("deleting the MAIN file is a recoverable soft-delete — no hard data loss (Security rec)", () => {
    const project = new CollabProject(new Y.Doc());
    registerAuthor(project, HUMAN);
    const mainId = project.create("/main.typ", "= Title\nimportant\n", HUMAN);
    expect(project.mainFileId()).toBe(mainId);

    applyAcceptedFileSetAsAgent(project, { creates: [], edits: [], deletes: [{ fileId: mainId }] }, "mcp");

    // mainFileId still points at it (paths are metadata) — the UI surfaces a
    // "pick a new main" recovery path; the bytes are NOT destroyed.
    expect(project.snapshot().files.find((f) => f.fileId === mainId)?.deleted).toBe(true);
    project.restore(mainId, HUMAN);
    expect(project.snapshot().files.find((f) => f.fileId === mainId)?.text).toBe("= Title\nimportant\n");
  });
});

describe("wireBlobSync (D1 online-only blob-sync, servable-provenance)", () => {
  const H = (c: string): string => c.repeat(64);
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const noop = (): (() => void) => () => {};

  const binFile = (over: Partial<BinaryFileSnapshot> & { hash: string }): BinaryFileSnapshot => ({
    fileId: `f-${over.hash.slice(0, 4)}`,
    path: `/img-${over.hash.slice(0, 4)}.png`,
    size: 3,
    mime: "image/png",
    deleted: false,
    ...over,
  });
  const binSnap = (binaryFiles: BinaryFileSnapshot[]): ProjectSnapshot => ({
    files: [],
    mainFileId: null,
    duplicatePaths: [],
    ...(binaryFiles.length > 0 ? { binaryFiles } : {}),
  });

  /** A blob store whose SERVABLE marker and byte presence are INDEPENDENT knobs. */
  const fakeBlobStore = (opts: {
    held?: Set<string>;
    servable?: Set<string>;
    bytesByHash?: Map<string, Uint8Array>;
  }): { has: (h: string) => Promise<boolean>; get: (h: string) => Promise<Uint8Array | undefined>; isServable: (h: string) => Promise<boolean> } => {
    const held = opts.held ?? new Set<string>();
    const servable = opts.servable ?? new Set<string>();
    const bytes = opts.bytesByHash ?? new Map<string, Uint8Array>();
    return {
      has: async (h) => held.has(h),
      get: async (h) => bytes.get(h),
      isServable: async (h) => servable.has(h),
    };
  };

  /** A recording channel that logs expect/unexpect/send call ORDER into a shared array. */
  const fakeChannel = (order: string[]) => {
    const expects: { hash: string; size: number }[] = [];
    const unexpects: { hash: string; size: number }[] = [];
    const sends: { bytes: Uint8Array; hash: string; mime: string }[] = [];
    return {
      expects,
      unexpects,
      sends,
      expect(hash: string, size: number): boolean {
        order.push(`expect:${hash.slice(0, 4)}`);
        expects.push({ hash, size });
        return true;
      },
      unexpect(hash: string, size: number): void {
        order.push(`unexpect:${hash.slice(0, 4)}`);
        unexpects.push({ hash, size });
      },
      send(bytes: Uint8Array, hash: string, mime: string) {
        order.push(`send:${hash.slice(0, 4)}`);
        sends.push({ bytes, hash, mime });
        return { transferId: "t", hash, done: Promise.resolve() };
      },
    };
  };

  /** A recording awareness that merges setLocalStateField into a mutable state object. */
  const fakeAwareness = (
    states: Map<number, Record<string, unknown>>,
    local: Record<string, unknown>,
    order: string[],
  ) => {
    const setCalls: { field: string; value: unknown }[] = [];
    return {
      local,
      setCalls,
      getStates: () => states,
      setLocalStateField(field: string, value: unknown): void {
        order.push("setfield");
        setCalls.push({ field, value });
        local[field] = value;
      },
    };
  };

  it("REQUESTER: expects referenced-and-missing hashes BEFORE advertising, preserving cursor presence", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const awareness = fakeAwareness(new Map(), { user: { name: "Ada", color: "#f0510e" } }, order);
    const handle = wireBlobSync({
      awareness,
      clientId: 1,
      snapshot: () => binSnap([binFile({ hash: H("a"), size: 10 })]),
      store: fakeBlobStore({}), // nothing present → missing
      channel,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
      mintRequestId: () => "req-1",
    });
    await handle.replan();

    expect(channel.expects).toEqual([{ hash: H("a"), size: 10 }]);
    expect(awareness.setCalls).toEqual([
      { field: BLOB_WANTS_FIELD, value: { v: 1, requestId: "req-1", hashes: [H("a")] } },
    ]);
    // EXPECT precedes ADVERTISE — no window for a peer to answer an un-expected hash.
    expect(order).toEqual(["expect:aaaa", "setfield"]);
    // setLocalStateField touched only the want field — the cursor/author presence survives.
    expect(awareness.local.user).toEqual({ name: "Ada", color: "#f0510e" });
    handle.destroy();
  });

  it("REQUESTER: advertises NOTHING when every referenced blob is already present", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const awareness = fakeAwareness(new Map(), {}, order);
    const handle = wireBlobSync({
      awareness,
      clientId: 1,
      snapshot: () => binSnap([binFile({ hash: H("a") })]),
      store: fakeBlobStore({ held: new Set([H("a")]) }), // present
      channel,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
      mintRequestId: () => "req-1",
    });
    await handle.replan();
    expect(channel.expects).toEqual([]);
    expect(awareness.setCalls).toEqual([]); // nothing wanted → no presence write
    handle.destroy();
  });

  it("HOLDER: serves a peer's wanted hash it HOLDS and has marked SERVABLE (serve authority is the marker, not the snapshot)", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const hash = H("a");
    const bytes = new Uint8Array([1, 2, 3]);
    const store = fakeBlobStore({
      held: new Set([hash]),
      servable: new Set([hash]),
      bytesByHash: new Map([[hash, bytes]]),
    });
    const states = new Map<number, Record<string, unknown>>([
      [2, { [BLOB_WANTS_FIELD]: { v: 1, requestId: "r2", hashes: [hash] } }],
    ]);
    const handle = wireBlobSync({
      awareness: fakeAwareness(states, {}, order),
      clientId: 1,
      // The local snapshot references NOTHING — the serve is authorized purely by the
      // durable servable marker, proving the holder never consults the snapshot.
      snapshot: () => binSnap([]),
      store,
      channel,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
    });
    await handle.replan();
    await flush(); // the send is fire-and-forget (store.get → channel.send)

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]!.hash).toBe(hash);
    expect(channel.sends[0]!.bytes).toEqual(bytes);
    handle.destroy();
  });

  it("HOLDER: does NOT serve a HELD-and-referenced-but-NOT-SERVABLE hash — exfil path closed end-to-end", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const hash = H("a");
    const bytes = new Uint8Array([9, 9, 9]);
    // The bytes ARE present and the hash IS referenced in the local (peer-writable)
    // snapshot — but the durable servable marker is UNSET (e.g. a pending, not-yet-
    // Accepted import). A snapshot-authorized holder WOULD disclose here; the
    // servable-provenance holder must NOT. This test FAILS if `servableHeld` were wired
    // to snapshot pointers (referenced+held) instead of `isServable(hash) && has(hash)`.
    const store = fakeBlobStore({
      held: new Set([hash]),
      servable: new Set(), // marker deliberately absent
      bytesByHash: new Map([[hash, bytes]]),
    });
    const states = new Map<number, Record<string, unknown>>([
      [2, { [BLOB_WANTS_FIELD]: { v: 1, requestId: "r2", hashes: [hash] } }],
    ]);
    const handle = wireBlobSync({
      awareness: fakeAwareness(states, {}, order),
      clientId: 1,
      snapshot: () => binSnap([binFile({ hash })]), // referenced — but that is NOT authority
      store,
      channel,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
    });
    await handle.replan();
    await flush();
    expect(channel.sends).toEqual([]); // no disclosure of a non-servable blob
    handle.destroy();
  });

  it("HOLDER: caps serve attempts at 2 per (clientId,hash) ACROSS requestId rotation; a fresh session resets the ledger", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const hash = H("b");
    const bytes = new Uint8Array([7]);
    const store = fakeBlobStore({
      held: new Set([hash]),
      servable: new Set([hash]),
      bytesByHash: new Map([[hash, bytes]]),
    });
    // Peer 2 keeps wanting the same hash but ROTATES its requestId each pass.
    const state2: Record<string, unknown> = {};
    const states = new Map<number, Record<string, unknown>>([[2, state2]]);
    const handle = wireBlobSync({
      awareness: fakeAwareness(states, {}, order),
      clientId: 1,
      snapshot: () => binSnap([]),
      store,
      channel,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
    });
    for (const rid of ["r0", "r1", "r2"]) {
      state2[BLOB_WANTS_FIELD] = { v: 1, requestId: rid, hashes: [hash] };
      await handle.replan();
      await flush();
    }
    // Initial + one retry — rotating requestId buys the requester NO extra transfer work.
    expect(channel.sends).toHaveLength(2);
    handle.destroy();

    // A FRESH session (reconnect / new Yjs clientID) mints a new ledger → serves again.
    const order2: string[] = [];
    const channel2 = fakeChannel(order2);
    const handle2 = wireBlobSync({
      awareness: fakeAwareness(
        new Map<number, Record<string, unknown>>([
          [2, { [BLOB_WANTS_FIELD]: { v: 1, requestId: "r9", hashes: [hash] } }],
        ]),
        {},
        order2,
      ),
      clientId: 1,
      snapshot: () => binSnap([]),
      store,
      channel: channel2,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
    });
    await handle2.replan();
    await flush();
    expect(channel2.sends).toHaveLength(1); // fresh ledger in the new session
    handle2.destroy();
  });

  it("HOLDER: coalesces multiple requesters of one hash into ONE broadcast, recording every (clientId,hash) attempted", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const hash = H("c");
    const bytes = new Uint8Array([5, 5]);
    const store = fakeBlobStore({
      held: new Set([hash]),
      servable: new Set([hash]),
      bytesByHash: new Map([[hash, bytes]]),
    });
    // Peers 2 AND 3 both want the same hash.
    const states = new Map<number, Record<string, unknown>>([
      [2, { [BLOB_WANTS_FIELD]: { v: 1, requestId: "r2", hashes: [hash] } }],
      [3, { [BLOB_WANTS_FIELD]: { v: 1, requestId: "r3", hashes: [hash] } }],
    ]);
    const handle = wireBlobSync({
      awareness: fakeAwareness(states, {}, order),
      clientId: 1,
      snapshot: () => binSnap([]),
      store,
      channel,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
    });
    await handle.replan();
    await flush();
    expect(channel.sends).toHaveLength(1); // ONE broadcast serves both requesters

    // Both (clientId,hash) were recorded attempted → the second pass yields at most one
    // MORE send (the single bounded retry), never one-per-requester amplification.
    await handle.replan();
    await flush();
    expect(channel.sends).toHaveLength(2);

    // Both capped at 2 → no further sends.
    await handle.replan();
    await flush();
    expect(channel.sends).toHaveLength(2);
    handle.destroy();
  });

  it("REQUESTER: unexpects a removed pointer and drops it from the want-list (no re-advertise after withdrawal)", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const awareness = fakeAwareness(new Map(), {}, order);
    const a = H("a");
    const b = H("b");
    let snap = binSnap([binFile({ hash: a, size: 3 }), binFile({ hash: b, size: 4 })]);
    let rid = 0;
    const handle = wireBlobSync({
      awareness,
      clientId: 1,
      snapshot: () => snap,
      store: fakeBlobStore({}), // both missing
      channel,
      subscribeDoc: noop,
      subscribeAwareness: noop,
      subscribeSynced: noop,
      mintRequestId: () => `req-${rid++}`,
    });
    await handle.replan();
    expect([...channel.expects].map((e) => e.hash).sort()).toEqual([a, b].sort());
    const firstAd = awareness.setCalls.at(-1)!.value as { hashes: string[] };
    expect([...firstAd.hashes].sort()).toEqual([a, b].sort());

    // Remove pointer `a`; replan.
    snap = binSnap([binFile({ hash: b, size: 4 })]);
    await handle.replan();

    expect(channel.unexpects).toEqual([{ hash: a, size: 3 }]); // its last pointer disappeared
    const lastAd = awareness.setCalls.at(-1)!.value as { hashes: string[] };
    expect(lastAd.hashes).toEqual([b]); // `a` is no longer advertised
    handle.destroy();
  });

  it("suppresses a STALE-generation plan: no expect/unexpect/advertise after the demand snapshot changed mid-flight", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const awareness = fakeAwareness(new Map(), {}, order);
    const a = H("a");
    let snap = binSnap([binFile({ hash: a, size: 3 })]);
    let capturedOnDoc: () => void = () => {};
    // A gated store.has: the first read hangs until we release it — long enough to mutate
    // the snapshot + fire a doc change (bumping the demand generation) mid-flight.
    let releaseHas!: () => void;
    const hasGate = new Promise<void>((r) => (releaseHas = r));
    const store = {
      has: async (_h: string): Promise<boolean> => {
        await hasGate;
        return false;
      },
      get: async (): Promise<Uint8Array | undefined> => undefined,
      isServable: async (): Promise<boolean> => false,
    };
    const handle = wireBlobSync({
      awareness,
      clientId: 1,
      snapshot: () => snap,
      store,
      channel,
      subscribeDoc: (cb) => {
        capturedOnDoc = cb;
        return () => {};
      },
      subscribeAwareness: noop,
      subscribeSynced: noop,
      mintRequestId: () => "req",
    });
    const p = handle.replan(); // reads snap {a}, captures gen 0, awaits store.has(a)
    // Mid-flight: remove `a` and fire the doc-change trigger → the demand generation bumps.
    snap = binSnap([]);
    capturedOnDoc();
    releaseHas();
    await p;
    await flush();
    // The stale plan (its captured generation is now behind) performed NO side effects:
    // `a` was never expected/unexpected/advertised, even though it was missing at start.
    expect(channel.expects).toEqual([]);
    expect(channel.unexpects).toEqual([]);
    expect(awareness.setCalls).toEqual([]);
    handle.destroy();
  });

  it("teardown: withdraws the awareness want-list, releases live expectations, unsubscribes, and is idempotent", async () => {
    const order: string[] = [];
    const channel = fakeChannel(order);
    const awareness = fakeAwareness(new Map(), {}, order);
    const a = H("a");
    let doc = 0;
    let aware = 0;
    let synced = 0;
    const handle = wireBlobSync({
      awareness,
      clientId: 1,
      snapshot: () => binSnap([binFile({ hash: a, size: 3 })]),
      store: fakeBlobStore({}), // missing → expected + advertised
      channel,
      subscribeDoc: () => () => {
        doc += 1;
      },
      subscribeAwareness: () => () => {
        aware += 1;
      },
      subscribeSynced: () => () => {
        synced += 1;
      },
      mintRequestId: () => "req",
    });
    await handle.replan();
    expect(channel.expects).toEqual([{ hash: a, size: 3 }]);
    awareness.setCalls.length = 0; // discard the advertise; focus on teardown effects

    handle.destroy();
    expect([doc, aware, synced]).toEqual([1, 1, 1]); // every listener unsubscribed
    expect(awareness.setCalls).toEqual([{ field: BLOB_WANTS_FIELD, value: null }]); // want-list withdrawn
    expect(channel.unexpects).toEqual([{ hash: a, size: 3 }]); // live expectation released

    handle.destroy(); // idempotent — no double unsubscribe / withdrawal
    expect([doc, aware, synced]).toEqual([1, 1, 1]);
    expect(awareness.setCalls).toHaveLength(1);
  });
});
