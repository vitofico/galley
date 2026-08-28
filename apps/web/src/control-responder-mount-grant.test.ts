import { describe, it, expect, beforeEach } from "vitest";
import {
  base64UrlToBytes,
  deriveProposalKey,
  signProposal,
  type DocHost,
  type SignableProposal,
} from "@galley/collab";
import * as Y from "yjs";
import {
  __resetControlResponderManagerForTests,
  getControlResponderManager,
  AGENT_ACCESS_GRANT_KEY,
  AGENT_ACCESS_SESSION_KEY,
  type ControlResponderMountDeps,
  type ControlLink,
} from "./control-responder-mount.js";
import type { ProposalGrant } from "./proposal-grant.js";
import { agentModeWrites } from "./components/agent-access-panel-mode.js";
import { isContentGranted } from "./agent-content-consent.js";

/**
 * Offline unit tests for the MOUNT's grant persistence + grant-scoped proposal
 * verifier (ADR-0023 §1/§4). The manager is the module-scope singleton; every
 * side effect is injected (room mint, control-room join, the session store) so
 * the suite runs fully offline in `node`. WebCrypto is real (Node 20+).
 *
 * What they pin:
 *   - recordGrant → getActiveGrant round-trips an in-memory grant.
 *   - setGrantMode persists the flipped disposition.
 *   - disable() clears the grant (a revoked capability's grant never returns).
 *   - getProposalVerifier is null without a grant, non-null with one.
 *   - verifyFor returns true for a correctly-signed proposal and false for a bad sig.
 */

/** A shared in-memory sessionStore so the test can read the persisted blobs. */
function makeStore() {
  const m = new Map<string, string>();
  return {
    store: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
    map: m,
  };
}

function baseDeps(over: Partial<ControlResponderMountDeps>): ControlResponderMountDeps {
  const doc = new Y.Doc();
  const host: DocHost = { doc };
  const joinControlRoom: ControlResponderMountDeps["joinControlRoom"] = () => {
    const link: ControlLink = { host, destroy() {} };
    return link;
  };
  return {
    mintControlRoom: () => "share-grantgrantgrantgrant00",
    resolveSyncUrl: () => "ws://127.0.0.1:1234",
    currentUserId: () => "local-test-user",
    listProjects: async () => [],
    listVersions: async () => null,
    createProject: async (name) => ({ projectId: "proj-new", name }),
    openProjectForControl: async () => ({ refused: "no" }),
    joinControlRoom,
    sessionStore: null,
    ...over,
  };
}

const A_GRANT: ProposalGrant = {
  controlRoom: "share-grantgrantgrantgrant00",
  projectId: "proj-1",
  shareRoom: "share-shareshareshareshare0",
  syncUrl: "ws://127.0.0.1:1234",
  mainFile: "/main.typ",
  grantId: "g0aBcDeF1234_-ZyXwVu",
  mode: "ask",
  grantedAt: 1_700_000_000_000,
};

/** The live session responseKey, read back from the persisted session blob. */
function readSessionKey(store: ReturnType<typeof makeStore>): Uint8Array {
  const raw = store.store.getItem(AGENT_ACCESS_SESSION_KEY);
  if (raw === null) throw new Error("no persisted session");
  const blob = JSON.parse(raw) as { responseKey: string };
  const key = base64UrlToBytes(blob.responseKey);
  if (key === null) throw new Error("bad key");
  return key;
}

const sample = (over: Partial<SignableProposal> = {}): SignableProposal => ({
  id: "abc",
  createdAt: 100,
  seq: 0,
  request: "do x",
  ops: [
    {
      kind: "edit",
      path: "/a.typ",
      newPath: null,
      baseText: "x",
      proposedText: "y",
      blocks: [{ search: "x", replace: "y" }],
    },
  ],
  ...over,
});

/**
 * Poll a store key until it is non-null (or a generous timeout). The grant
 * persist is async (a WebCrypto MAC); a single macrotask is NOT reliably enough
 * for subtle ops to resolve under load, so tests that read the persisted blob
 * poll instead of guessing a fixed delay.
 */
async function waitForItem(
  store: { getItem: (k: string) => string | null },
  key: string,
): Promise<string | null> {
  for (let i = 0; i < 200; i++) {
    const v = store.getItem(key);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  return store.getItem(key);
}

beforeEach(() => {
  __resetControlResponderManagerForTests();
});

describe("control-responder-mount — grant record (ADR-0023 §4)", () => {
  it("recordGrant → getActiveGrant round-trips and persists the blob", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    expect(mgr.getActiveGrant()).toBeNull();
    mgr.recordGrant(A_GRANT);
    expect(mgr.getActiveGrant()).toEqual(A_GRANT);
    // The MAC + persist is async (WebCrypto) but the in-memory grant is immediate.
    expect(mgr.getActiveGrant()?.grantId).toBe(A_GRANT.grantId);
  });

  it("recordGrant is a no-op without a live session key", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    // Not enabled → no responseKey → nothing can MAC a grant.
    mgr.recordGrant(A_GRANT);
    expect(mgr.getActiveGrant()).toBeNull();
  });

  it("setGrantMode flips + persists the disposition", async () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    expect(mgr.getActiveGrant()?.mode).toBe("ask");
    mgr.setGrantMode("auto");
    expect(mgr.getActiveGrant()?.mode).toBe("auto");
    // The persist is async (WebCrypto MAC); poll until the blob lands rather than
    // assume a single macrotask is enough (subtle ops can resolve a tick later).
    const raw = await waitForItem(s.store, AGENT_ACCESS_GRANT_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).mode).toBe("auto");
  });

  it("setGrantPersistentAccess(true) sets the flag, re-MACs/persists it, and grants content access (F13)", async () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT); // projectId "proj-1", persistentAccess absent
    expect(mgr.getActiveGrant()?.persistentAccess).toBeUndefined();
    expect(isContentGranted(s.store, "proj-1")).toBe(false);
    mgr.setGrantPersistentAccess(true);
    expect(mgr.getActiveGrant()?.persistentAccess).toBe(true);
    // Turning it ON also grants per-project file access (the host materialises the doc).
    expect(isContentGranted(s.store, "proj-1")).toBe(true);
    // The flag is MAC-COVERED → re-persisted; the blob carries it and re-loads valid.
    const raw = await waitForItem(s.store, AGENT_ACCESS_GRANT_KEY);
    expect(JSON.parse(raw!).persistentAccess).toBe(true);
  });

  it("setGrantPersistentAccess(false) clears the flag (OFF MACs like a legacy blob)", async () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant({ ...A_GRANT, persistentAccess: true });
    expect(mgr.getActiveGrant()?.persistentAccess).toBe(true);
    mgr.setGrantPersistentAccess(false);
    // The field is REMOVED (not set false) so an OFF grant is byte-identical to legacy.
    expect(mgr.getActiveGrant()?.persistentAccess).toBeUndefined();
    const raw = await waitForItem(s.store, AGENT_ACCESS_GRANT_KEY);
    // A persistGrant from the recordGrant(true) may have landed first; poll until the
    // OFF blob (no persistentAccess key) is the one persisted.
    for (let i = 0; i < 50 && JSON.parse(s.store.getItem(AGENT_ACCESS_GRANT_KEY)!).persistentAccess === true; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(JSON.parse(s.store.getItem(AGENT_ACCESS_GRANT_KEY)!).persistentAccess).toBeUndefined();
    void raw;
  });

  it("setGrantPersistentAccess is a no-op without a live session / active grant (fail-closed)", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.setGrantPersistentAccess(true); // no grant yet
    expect(mgr.getActiveGrant()).toBeNull();
  });

  it("grantContentForActiveGrant mints content access for the active grant's project (F13 consent collapse)", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    expect(isContentGranted(s.store, "proj-1")).toBe(false);
    mgr.recordGrant(A_GRANT); // projectId "proj-1"
    mgr.grantContentForActiveGrant();
    // One consent now satisfies the read gate too — no separate "Allow file access".
    expect(isContentGranted(s.store, "proj-1")).toBe(true);
    // Scoped: a DIFFERENT project is never granted by this project's consent.
    expect(isContentGranted(s.store, "proj-2")).toBe(false);
  });

  it("grantContentForActiveGrant is a no-op with no active grant (fail-closed)", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.grantContentForActiveGrant();
    expect(isContentGranted(s.store, "proj-1")).toBe(false);
  });

  it("disable() clears the grant + the persisted blob", async () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    expect(await waitForItem(s.store, AGENT_ACCESS_GRANT_KEY)).not.toBeNull();
    mgr.disable();
    expect(mgr.getActiveGrant()).toBeNull();
    expect(s.store.getItem(AGENT_ACCESS_GRANT_KEY)).toBeNull();
  });
});

describe("control-responder-mount — getActiveGrantForProject (H1 scoped authority)", () => {
  it("returns the grant when projectId matches, null when it differs", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT); // projectId "proj-1"
    expect(mgr.getActiveGrantForProject("proj-1")).toEqual(A_GRANT);
    // A DIFFERENT project (B) must never read project A's grant (no carry-over).
    expect(mgr.getActiveGrantForProject("proj-2")).toBeNull();
  });

  it("returns null when the shareRoom is supplied but does not match", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    // Same project, matching room → grant.
    expect(mgr.getActiveGrantForProject("proj-1", A_GRANT.shareRoom)).toEqual(A_GRANT);
    // Same project, WRONG room → fail closed.
    expect(mgr.getActiveGrantForProject("proj-1", "share-someothershareroom00")).toBeNull();
  });

  it("returns null when there is no active grant", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    expect(mgr.getActiveGrantForProject("proj-1")).toBeNull();
  });

  it("a project-B panel selection writes NO grant store (grantActive scoped false)", () => {
    // The panel computes `grantActive` from the SCOPED read, then feeds it to the
    // pure `agentModeWrites`. With project A's grant live, project B's UI must see
    // grantActive=false → never call setGrantMode → cannot flip project A's mode.
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT); // project "proj-1"
    const grantActiveForB = mgr.getActiveGrantForProject("proj-2") !== null;
    expect(grantActiveForB).toBe(false);
    expect(agentModeWrites("auto", grantActiveForB).grant).toBe(false);
    // Project A's own UI still writes the grant store.
    const grantActiveForA = mgr.getActiveGrantForProject("proj-1") !== null;
    expect(agentModeWrites("auto", grantActiveForA).grant).toBe(true);
  });
});

describe("control-responder-mount — clearActiveGrant (ADR-0024 §3 Stop-sharing fix)", () => {
  it("clears the in-memory + persisted grant + verifier WITHOUT revoking the session", async () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    expect(await waitForItem(s.store, AGENT_ACCESS_GRANT_KEY)).not.toBeNull();
    expect(mgr.getProposalVerifier()).not.toBeNull();

    mgr.clearActiveGrant();

    // Grant + verifier + persisted blob are gone …
    expect(mgr.getActiveGrant()).toBeNull();
    expect(mgr.getProposalVerifier()).toBeNull();
    expect(mgr.getAudit()).toBeNull();
    expect(s.store.getItem(AGENT_ACCESS_GRANT_KEY)).toBeNull();
    // … but the agent stays PAIRED: the control session is still live.
    expect(mgr.isEnabled()).toBe(true);
    expect(s.store.getItem(AGENT_ACCESS_SESSION_KEY)).not.toBeNull();
  });

  it("emits so subscribers (the ProjectApp grant mirror) update", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    let emits = 0;
    const unsub = mgr.subscribe(() => (emits += 1));
    mgr.clearActiveGrant();
    expect(emits).toBe(1);
    unsub();
  });

  it("is idempotent — a no-op (no emit) when there is no active grant", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    let emits = 0;
    const unsub = mgr.subscribe(() => (emits += 1));
    mgr.clearActiveGrant();
    expect(mgr.getActiveGrant()).toBeNull();
    expect(emits).toBe(0);
    unsub();
  });

  it("after clear, a fresh construction (reload) does NOT re-bind the old grant", async () => {
    // Stop sharing clears the persisted blob, so the next boot's resume finds no
    // grant to re-bind — the old share room is never silently reopened.
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    expect(await waitForItem(s.store, AGENT_ACCESS_GRANT_KEY)).not.toBeNull();
    mgr.clearActiveGrant();
    expect(s.store.getItem(AGENT_ACCESS_GRANT_KEY)).toBeNull();

    // Simulate a reload: drop the singleton and reconstruct against the SAME store
    // (the session blob still resumes the pairing, but the grant blob is gone).
    __resetControlResponderManagerForTests();
    const reloaded = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    // Let any async resume settle, then assert no grant re-bound.
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));
    expect(reloaded.getActiveGrant()).toBeNull();
  });
});

describe("control-responder-mount — grant-scoped verifier (ADR-0023 §1)", () => {
  it("getProposalVerifier is null without a grant, non-null with one", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    expect(mgr.getProposalVerifier()).toBeNull();
    mgr.recordGrant(A_GRANT);
    expect(mgr.getProposalVerifier()).not.toBeNull();
  });

  it("verifyFor returns true for a correctly-signed proposal, false for a bad sig", async () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    const verifier = mgr.getProposalVerifier();
    expect(verifier).not.toBeNull();

    // Sign with the SAME derived key the verifier uses: read the session key,
    // build the same scope, derive K, sign the proposal.
    const responseKey = readSessionKey(s);
    const scope = verifier!.scopeFor("mcpFileProposals");
    const K = await deriveProposalKey(responseKey, scope);
    const signable = sample();
    const sig = await signProposal(K, scope, signable);

    expect(await verifier!.verifyFor(scope, signable, sig)).toBe(true);
    // A bad sig (truncated) and a missing sig both verify false (fail-closed).
    expect(await verifier!.verifyFor(scope, signable, "AAAA")).toBe(false);
    expect(await verifier!.verifyFor(scope, signable, undefined)).toBe(false);
    // A tampered signable (different request) fails against the captured sig.
    expect(await verifier!.verifyFor(scope, sample({ request: "do z" }), sig)).toBe(false);
  });

  it("scopeFor binds the active grant's coordinates per mailbox", () => {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    const v = mgr.getProposalVerifier()!;
    expect(v.scopeFor("mcpProposals")).toEqual({
      grantId: A_GRANT.grantId,
      controlRoom: A_GRANT.controlRoom,
      syncUrl: A_GRANT.syncUrl,
      projectId: A_GRANT.projectId,
      shareRoom: A_GRANT.shareRoom,
      mailbox: "mcpProposals",
    });
    expect(v.scopeFor("mcpFileProposals").mailbox).toBe("mcpFileProposals");
  });
});

describe("control-responder-mount — grant resume / re-bind (ADR-0023 §4, fail-closed)", () => {
  // Poll until `pred()` holds or a generous timeout — the resume grant load is an
  // async WebCrypto MAC, settling a few ticks after construction.
  async function waitFor(pred: () => boolean): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return pred();
  }
  // Drain ticks when we EXPECT the grant to STAY null — we cannot poll for null
  // (indistinguishable from "not loaded yet"), so let the async load fully settle.
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));
  }

  // Arm a real session+grant in a throwaway store and CAPTURE the two persisted
  // blob strings. We snapshot rather than reuse the store because the singleton
  // reset is destructive (disable() clears the persisted blobs) — so resume must
  // run against a FRESH store the reset never touched (the bug B10 was about).
  async function capturePersistedArmedBlobs(): Promise<{ session: string; grant: string }> {
    const s = makeStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: s.store }));
    mgr.enable();
    mgr.recordGrant(A_GRANT);
    mgr.setGrantMode("auto");
    await waitFor(() => {
      const r = s.store.getItem(AGENT_ACCESS_GRANT_KEY);
      return r !== null && (JSON.parse(r) as { mode: string }).mode === "auto";
    });
    const session = s.store.getItem(AGENT_ACCESS_SESSION_KEY);
    const grant = s.store.getItem(AGENT_ACCESS_GRANT_KEY);
    if (session === null || grant === null) throw new Error("seed failed");
    return { session, grant };
  }

  // A fresh store pre-seeded with a session blob and (optionally mutated) grant blob.
  function seededStore(session: string, grant: string | null) {
    const s = makeStore();
    s.store.setItem(AGENT_ACCESS_SESSION_KEY, session);
    if (grant !== null) s.store.setItem(AGENT_ACCESS_GRANT_KEY, grant);
    return s;
  }

  it("(a) a VALID armed grant resumes — getActiveGrant non-null, mode survives", async () => {
    const { session, grant } = await capturePersistedArmedBlobs();
    __resetControlResponderManagerForTests();
    const s2 = seededStore(session, grant);
    const mgr2 = getControlResponderManager(baseDeps({ sessionStore: s2.store }));
    expect(await waitFor(() => mgr2.isEnabled())).toBe(true); // the session re-binds
    expect(await waitFor(() => mgr2.getActiveGrant() !== null)).toBe(true);
    expect(mgr2.getActiveGrant()?.grantId).toBe(A_GRANT.grantId);
    expect(mgr2.getActiveGrant()?.mode).toBe("auto");
  });

  it("(b) a TAMPERED-MAC grant blob fails closed — session resumes, NO active grant", async () => {
    const { session, grant } = await capturePersistedArmedBlobs();
    // Tamper ONLY the MAC; the grant fields stay well-formed so the failure is the
    // MAC verification in loadPersistedGrant, not a shape rejection in parseGrant.
    const blob = JSON.parse(grant) as { mac: string };
    blob.mac = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    __resetControlResponderManagerForTests();
    const s2 = seededStore(session, JSON.stringify(blob));
    const mgr2 = getControlResponderManager(baseDeps({ sessionStore: s2.store }));
    expect(await waitFor(() => mgr2.isEnabled())).toBe(true);
    await settle();
    expect(mgr2.getActiveGrant()).toBeNull(); // fail-closed through the MAC check
  });

  it("(c) a CORRUPT (unparseable) grant blob resumes the session but yields no grant", async () => {
    const { session } = await capturePersistedArmedBlobs();
    __resetControlResponderManagerForTests();
    const s2 = seededStore(session, "{ not json");
    const mgr2 = getControlResponderManager(baseDeps({ sessionStore: s2.store }));
    expect(await waitFor(() => mgr2.isEnabled())).toBe(true);
    await settle();
    expect(mgr2.getActiveGrant()).toBeNull();
  });
});
