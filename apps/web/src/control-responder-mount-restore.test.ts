import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  publishControlRequest,
  getControlResponse,
  type DocHost,
  type ControlResponse,
  type FileProposalOp,
} from "@galley/collab";
import type { Author } from "@galley/shared";
import {
  __resetControlResponderManagerForTests,
  getControlResponderManager,
  CONTENT_CONSENT_REQUIRED_ERROR,
  TOOL_PROJECT_ID_REQUIRED_ERROR,
  type ControlResponderMountDeps,
  type ControlLink,
  type RestoreVersionHandler,
} from "./control-responder-mount.js";
import { grantContentAccess } from "./agent-content-consent.js";
import type { RestoreFile } from "./control-responder.js";

/**
 * B3 `request_restore_version` mount wiring: the restore op rides the SAME
 * per-project content-consent gate as the other content ops, computes the diff
 * (live project → target version) via the pure core, and PUBLISHES it as a
 * normal file proposal through the ProjectApp-registered restore handler. The
 * kernel NEVER writes files — the mount only triggers the proposal.
 */

const REQUESTER: Author = { kind: "human", userId: "test-kernel" };

function makeMemoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeLink {
  link: ControlLink;
  kernelHost: DocHost;
}

function makeFakeLinkFactory(): {
  joinControlRoom: ControlResponderMountDeps["joinControlRoom"];
  state: FakeLink;
} {
  const doc = new Y.Doc();
  const kernelHost: DocHost = { doc };
  const state: FakeLink = { link: undefined as unknown as ControlLink, kernelHost };
  const joinControlRoom: ControlResponderMountDeps["joinControlRoom"] = () => {
    const link: ControlLink = { host: kernelHost, destroy() {} };
    state.link = link;
    return link;
  };
  return { joinControlRoom, state };
}

const LIVE_FILES: RestoreFile[] = [{ path: "/main.typ", text: "live body" }];
const VERSION_TREE: RestoreFile[] = [
  { path: "/main.typ", text: "restored body" },
  { path: "/added.typ", text: "new at version" },
];

interface RestoreHarness {
  mgr: ReturnType<typeof getControlResponderManager>;
  state: FakeLink;
  store: ReturnType<typeof makeMemoryStore>;
  published: Array<{ request: string; ops: FileProposalOp[] }>;
  liveCalls: string[];
}

function makeRestoreHarness(over: {
  registerHandler?: boolean;
  liveFileSet?: (projectId: string) => Promise<RestoreFile[] | null>;
  versionTree?: (projectId: string, versionId: string) => Promise<RestoreFile[] | null>;
  versionName?: (projectId: string, versionId: string) => Promise<string | null>;
  publish?: (input: { request: string; ops: FileProposalOp[] }) => Promise<string>;
} = {}): RestoreHarness {
  const { joinControlRoom, state } = makeFakeLinkFactory();
  const store = makeMemoryStore();
  const published: Array<{ request: string; ops: FileProposalOp[] }> = [];
  const liveCalls: string[] = [];

  const mgr = getControlResponderManager({
    mintControlRoom: () => "share-test00000000000000000",
    resolveSyncUrl: () => "ws://127.0.0.1:1234",
    currentUserId: () => "local-test-user",
    listProjects: async () => [{ projectId: "proj-1", name: "Alpha" }],
    listVersions: async (projectId) =>
      projectId === "proj-1" ? [{ id: "v1", name: "Final draft" }] : null,
    createProject: async (name) => ({ projectId: "proj-new", name }),
    openProjectForControl: async () => ({ refused: "nothing open" }),
    joinControlRoom,
    sessionStore: store,
    // The B4 version-tree seam doubles as the restore TARGET source.
    projectVersionTree:
      over.versionTree ??
      (async (projectId, versionId) =>
        projectId === "proj-1" && versionId === "v1" ? VERSION_TREE : null),
  });

  if (over.registerHandler !== false) {
    const handler: RestoreVersionHandler = {
      liveFileSet: async (projectId) => {
        liveCalls.push(projectId);
        if (over.liveFileSet) return over.liveFileSet(projectId);
        return projectId === "proj-1" ? LIVE_FILES : null;
      },
      publish: async (input) => {
        if (over.publish) return over.publish(input);
        published.push(input);
        return "prop-minted-1";
      },
    };
    mgr.registerRestoreVersionHandler(handler);
  }

  mgr.enable();
  return { mgr, state, store, published, liveCalls };
}

async function publishAndAwait(
  state: FakeLink,
  params: Record<string, unknown>,
): Promise<ControlResponse | undefined> {
  const id = publishControlRequest(
    state.kernelHost,
    { op: "request_restore_version", params },
    REQUESTER,
  );
  await flush();
  return getControlResponse(state.kernelHost, id);
}

beforeEach(() => {
  __resetControlResponderManagerForTests();
});

describe("request_restore_version — consent-gated, never a direct mutation (B3)", () => {
  it("without a content grant: the STATIC consent refusal, and the live set is NEVER read", async () => {
    const h = makeRestoreHarness();
    const resp = await publishAndAwait(h.state, { projectId: "proj-1", versionId: "v1" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(
      CONTENT_CONSENT_REQUIRED_ERROR,
    );
    // Consent is the FIRST wall — no live-project read, no publish before it.
    expect(h.liveCalls).toEqual([]);
    expect(h.published).toEqual([]);
    // No file text leaked in the refusal.
    for (const f of [...LIVE_FILES, ...VERSION_TREE]) {
      expect(JSON.stringify(resp)).not.toContain(f.text.slice(0, 6));
    }
  });

  it("a request WITHOUT a projectId is refused with the static param error", async () => {
    const h = makeRestoreHarness();
    const resp = await publishAndAwait(h.state, { versionId: "v1" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(
      TOOL_PROJECT_ID_REQUIRED_ERROR,
    );
  });

  it("granted but no project open (no handler) → a not_open STATUS (ok:true, C2), NOTHING published", async () => {
    const h = makeRestoreHarness({ registerHandler: false });
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, { projectId: "proj-1", versionId: "v1" });
    // C2: not_open is a STRUCTURED ok:true status (survives the kernel's
    // refusal-flattening), NOT a refusal.
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({ status: "not_open" });
    expect(h.published).toEqual([]);
  });

  it("granted, project open, real diff → publishes the restore proposal and returns { restore_proposed, proposalId }", async () => {
    const h = makeRestoreHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, { projectId: "proj-1", versionId: "v1" });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as {
      status: string;
      proposalId: string;
    };
    expect(result.status).toBe("restore_proposed");
    expect(result.proposalId).toBe("prop-minted-1");
    // The published proposal carries the right title + the live→version diff ops.
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.request).toBe('Restore to "Final draft"');
    expect(h.published[0]!.ops).toEqual([
      { kind: "create", path: "/added.typ", baseText: "", proposedText: "new at version", blocks: [] },
      { kind: "edit", path: "/main.typ", baseText: "live body", proposedText: "restored body", blocks: [] },
    ]);
  });

  it("granted but the project already equals the version → no_changes, NOTHING published", async () => {
    const h = makeRestoreHarness({
      liveFileSet: async () => [{ path: "/main.typ", text: "same" }],
      versionTree: async () => [{ path: "/main.typ", text: "same" }],
    });
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, { projectId: "proj-1", versionId: "v1" });
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({ status: "no_changes" });
    expect(h.published).toEqual([]);
  });

  it("granted but an unknown version → an unknown_version STATUS (ok:true), NOTHING published", async () => {
    const h = makeRestoreHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, { projectId: "proj-1", versionId: "v-nope" });
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({
      status: "unknown_version",
    });
    expect(h.published).toEqual([]);
  });

  it("granted but the LIVE set has a duplicate path (C3) → conflict STATUS, NOTHING published", async () => {
    const h = makeRestoreHarness({
      liveFileSet: async () => [
        { path: "/main.typ", text: "copy A" },
        { path: "/main.typ", text: "copy B" },
      ],
      versionTree: async () => [{ path: "/main.typ", text: "copy A" }],
    });
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, { projectId: "proj-1", versionId: "v1" });
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({ status: "conflict" });
    expect(h.published).toEqual([]);
  });

  it("a THROWING publish seam is refused generically and never wedges the loop", async () => {
    const h = makeRestoreHarness({
      publish: async () => {
        throw new Error("idb exploded with /secret internals");
      },
    });
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, { projectId: "proj-1", versionId: "v1" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).not.toContain("secret");
    // The loop still serves the next request.
    const next = publishControlRequest(h.state.kernelHost, { op: "list_projects", params: {} }, REQUESTER);
    await flush();
    expect(getControlResponse(h.state.kernelHost, next)?.ok).toBe(true);
  });
});
