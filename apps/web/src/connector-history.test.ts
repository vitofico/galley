import { describe, expect, it } from "vitest";
import { CollabProject, materializeProject } from "@galley/collab";
import { InMemoryVersionStore } from "@galley/persistence";
import type { ConnectorActivityEntry, ConnectorCheckpoint } from "@galley/shared";
import type { CapabilityFetch } from "./capability-rooms-client.js";
import {
  createConnectorHistoryVersionStore,
  restoreConnectorCheckpoint,
} from "./connector-history.js";

const HUMAN = { kind: "human", userId: "alice" } as const;
const ROOM = "share-0123456789abcdef0123456789abcdef";
const idAt = (ms: number, fill = "a") =>
  `${String(ms).padStart(13, "0")}-${fill.repeat(64)}`;

const change = (
  over: Partial<ConnectorActivityEntry & { restorable: boolean }>,
) => ({
  version: 1,
  changeId: "c1",
  state: "applied",
  atMs: 1,
  tokenId: "aaaaaaaaaaaaaaaa",
  request: "Fix a typo",
  files: ["/main.typ"],
  ops: 1,
  bytes: 3,
  checkpointId: idAt(2000),
  restorable: true,
  ...over,
});

/** The web server, as far as this module asks it. */
const server = (
  changes: unknown[],
  checkpoints: Record<string, ConnectorCheckpoint> = {},
): CapabilityFetch =>
  (async (path: string) => {
    const hit = path.endsWith("/activity")
      ? { ok: true, changes }
      : checkpoints[path.split("/").at(-1)!];
    return {
      ok: hit !== undefined,
      status: hit !== undefined ? 200 : 404,
      json: async () => hit ?? { ok: false, code: "not_found" },
    };
  }) as unknown as CapabilityFetch;

describe("connector checkpoints in History", () => {
  it("is exactly the local store while the project is not connected", async () => {
    const local = new InMemoryVersionStore();
    await local.createVersion("p", { name: "Mine" }, [{ path: "main.typ", text: "x" }]);
    const store = createConnectorHistoryVersionStore(local, () => undefined, () => {
      throw new Error("no request expected");
    });
    expect((await store.listVersions("p")).map((v) => v.name)).toEqual(["Mine"]);
    expect(await store.getVersionTree(`connector:${idAt(1)}`)).toBeNull();
  });

  it("lists the checkpoints worth going back to, and serves their trees", async () => {
    const local = new InMemoryVersionStore();
    await local.createVersion("p", { name: "Mine" }, [{ path: "main.typ", text: "x" }]);
    const kept: ConnectorCheckpoint = {
      version: 1,
      files: [{ path: "main.typ", text: "before" }],
      binaryFiles: [],
    };
    const store = createConnectorHistoryVersionStore(
      local,
      () => ROOM,
      server(
        [
          change({ request: "Later" , checkpointId: idAt(3000, "b") }),
          change({ changeId: "c2", request: "Earlier", checkpointId: idAt(2000) }),
          // Applied nothing, or no longer kept: nothing to go back to.
          change({ changeId: "c3", state: "conflict", checkpointId: idAt(4000, "c") }),
          change({ changeId: "c4", restorable: false, checkpointId: idAt(5000, "d") }),
        ],
        { [idAt(2000)]: kept },
      ),
    );
    const versions = await store.listVersions("p");
    expect(versions.map((v) => v.name)).toEqual([
      "Mine",
      "Before the connector's change: Earlier",
      "Before the connector's change: Later",
    ]);
    expect(versions[1]).toEqual({
      id: `connector:${idAt(2000)}`,
      projectId: "p",
      name: "Before the connector's change: Earlier",
    });
    expect(await store.getVersionTree(versions[1]!.id)).toEqual(kept.files);
    expect(await store.getVersionTree(versions[0]!.id)).toEqual([
      { path: "main.typ", text: "x" },
    ]);
  });

  it("falls back to the local versions when the server cannot be asked", async () => {
    const local = new InMemoryVersionStore();
    await local.createVersion("p", { name: "Mine" }, []);
    const store = createConnectorHistoryVersionStore(local, () => ROOM, (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as CapabilityFetch);
    expect((await store.listVersions("p")).map((v) => v.name)).toEqual(["Mine"]);
  });
});

describe("restoring a connector checkpoint", () => {
  const HASH = "c".repeat(64);
  const before = () => {
    const old = new CollabProject();
    old.create("/main.typ", "before the change\n", HUMAN);
    old.create("/gone.typ", "removed by the change\n", HUMAN);
    old.createBinary("/logo.png", { type: "binary", hash: HASH, size: 3, mime: "image/png" }, HUMAN);
    const tree = materializeProject(old.snapshot());
    if (!tree.ok) throw new Error("fixture");
    return {
      version: 1 as const,
      files: tree.result.files.map((f) => ({ path: f.path, text: f.text })),
      binaryFiles: [{ path: "/logo.png", hash: HASH, size: 3, mime: "image/png" }],
    };
  };
  const live = () => {
    const project = new CollabProject();
    project.create("/main.typ", "after the change\n", HUMAN);
    project.create("/added.typ", "added by the change\n", HUMAN);
    return project;
  };
  const texts = (project: CollabProject) =>
    Object.fromEntries(
      project
        .snapshot()
        .files.filter((f) => !f.deleted)
        .map((f) => [f.path, f.text]),
    );

  it("puts the text and the binary pointers back, as the person's own edits", async () => {
    const project = live();
    const id = idAt(2000);
    expect(
      await restoreConnectorCheckpoint(project, `connector:${id}`, ROOM, HUMAN, server([], { [id]: before() })),
    ).toBe(true);
    expect(texts(project)).toEqual({
      "/main.typ": "before the change\n",
      "/gone.typ": "removed by the change\n",
    });
    expect(
      (project.snapshot().binaryFiles ?? []).filter((f) => !f.deleted).map((f) => f.path),
    ).toEqual(["/logo.png"]);
  });

  it("leaves other versions to the caller", async () => {
    const project = live();
    expect(await restoreConnectorCheckpoint(project, "ver-1", ROOM, HUMAN, server([]))).toBe(false);
    expect(texts(project)["/main.typ"]).toBe("after the change\n");
  });

  it("changes nothing when the checkpoint is gone, malformed or unsafe", async () => {
    const id = idAt(2000);
    const unsafe = { ...before(), binaryFiles: [{ path: "/main.typ", hash: HASH, size: 3, mime: "image/png" }] };
    for (const fetchImpl of [
      server([]),
      server([], { [id]: { version: 2 } as unknown as ConnectorCheckpoint }),
      server([], { [id]: unsafe }),
    ]) {
      const project = live();
      await expect(
        restoreConnectorCheckpoint(project, `connector:${id}`, ROOM, HUMAN, fetchImpl),
      ).rejects.toThrow();
      expect(texts(project)).toEqual({
        "/main.typ": "after the change\n",
        "/added.typ": "added by the change\n",
      });
    }
    await expect(
      restoreConnectorCheckpoint(live(), `connector:${id}`, undefined, HUMAN, server([])),
    ).rejects.toThrow();
  });
});
