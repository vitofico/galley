import { afterEach, expect, it, vi } from "vitest";
import { CollabProject, materializeProject, sha256Hex } from "@galley/collab";
import { InMemoryVersionStore } from "@galley/persistence";
import * as Y from "yjs";
import {
  createHostedHistoryVersionStore,
  restoreHostedHistoryVersion,
} from "./hosted-history.js";
const globalConfig = globalThis as { __GALLEY_CONFIG__?: unknown };
afterEach(() => {
  delete globalConfig.__GALLEY_CONFIG__;
});
const human = { kind: "human", userId: "alice" } as const;
const target = { syncUrl: "wss://sync.test", room: "room" };
it("leaves local history offline by default and adds bounded hosted checkpoints only when configured", async () => {
  const local = new InMemoryVersionStore();
  const request = vi.fn<typeof fetch>();
  const store = createHostedHistoryVersionStore(local, () => target, request);
  await store.createVersion("project", { name: "Local" }, [
    { path: "main.typ", text: "local" },
  ]);
  expect(await store.listVersions("project")).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  globalConfig.__GALLEY_CONFIG__ = { hostedStorage: true };
  const id = `1800000000000-${"a".repeat(64)}`;
  request.mockResolvedValue(
    new Response(JSON.stringify([{ id, createdAt: 1800000000000, size: 20 }]), {
      status: 200,
    }),
  );
  const versions = await store.listVersions("project");
  expect(versions).toHaveLength(2);
  expect(versions[1]?.id).toBe(`hosted:room:${id}`);
  expect(request.mock.calls[0]?.[0]).toBe("https://sync.test/history/room");
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    credentials: "include",
    cache: "no-store",
  });
});
it("restores text and binary pointers through fresh human CRDT operations, retaining instructions and fetching no unrelated room", async () => {
  globalConfig.__GALLEY_CONFIG__ = { hostedStorage: true };
  const old = new CollabProject();
  old.create("/main.typ", "old", human);
  old.createBinary(
    "/old.png",
    { type: "binary", hash: "a".repeat(64), size: 3, mime: "image/png" },
    human,
  );
  const bytes = Y.encodeStateAsUpdate(old.doc);
  const id = `1800000000000-${await sha256Hex(bytes)}`;
  old.doc.destroy();
  const project = new CollabProject();
  project.create("/main.typ", "current", human);
  project.create("/.galley/instructions", "keep", human);
  project.createBinary(
    "/new.png",
    { type: "binary", hash: "b".repeat(64), size: 4, mime: "image/png" },
    human,
  );
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(new Uint8Array(bytes).buffer));
  try {
    expect(
      await restoreHostedHistoryVersion(
        project,
        "local-version",
        target,
        human,
        request,
      ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await expect(
      restoreHostedHistoryVersion(
        project,
        `hosted:other:${id}`,
        target,
        human,
        request,
      ),
    ).rejects.toThrow("another room");
    expect(request).not.toHaveBeenCalled();
    expect(
      await restoreHostedHistoryVersion(
        project,
        `hosted:room:${id}`,
        target,
        human,
        request,
      ),
    ).toBe(true);
    const snapshot = project.snapshot();
    expect(
      snapshot.files.filter((f) => !f.deleted).map((f) => [f.path, f.text]),
    ).toEqual([
      ["/.galley/instructions", "keep"],
      ["/main.typ", "old"],
    ]);
    expect(
      snapshot.binaryFiles?.filter((f) => !f.deleted).map((f) => f.path),
    ).toEqual(["/old.png"]);
    expect(
      snapshot.binaryFiles?.find((f) => f.path === "/new.png")?.deleted,
    ).toBe(true);
  } finally {
    project.doc.destroy();
  }
});
it("rejects corrupt or unsafe hosted snapshots before changing live state", async () => {
  globalConfig.__GALLEY_CONFIG__ = { hostedStorage: true };
  const saved = new CollabProject();
  saved.create("/main.typ", "old", human);
  saved.createBinary(
    "/main.typ",
    { type: "binary", hash: "a".repeat(64), size: 3, mime: "image/png" },
    human,
  );
  const bytes = Y.encodeStateAsUpdate(saved.doc);
  const id = `1800000000000-${await sha256Hex(bytes)}`;
  saved.doc.destroy();
  const project = new CollabProject();
  project.create("/main.typ", "current", human);
  try {
    await expect(
      restoreHostedHistoryVersion(
        project,
        `hosted:room:${id}`,
        target,
        human,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(new Uint8Array(bytes).buffer)),
      ),
    ).rejects.toThrow("Unsafe");
    expect(project.snapshot().files[0]?.text).toBe("current");
    await expect(
      restoreHostedHistoryVersion(
        project,
        `hosted:room:${id}`,
        target,
        human,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
      ),
    ).rejects.toThrow("integrity");
    expect(project.snapshot().files[0]?.text).toBe("current");
  } finally {
    project.doc.destroy();
  }
});
it("requires hosted checkpoint success for a hosted save and binds the request to the saved text tree", async () => {
  globalConfig.__GALLEY_CONFIG__ = { hostedStorage: true };
  const local = new InMemoryVersionStore();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 409 }));
  const store = createHostedHistoryVersionStore(local, () => target, request);
  const files = [{ path: "main.typ", text: "version" }];
  await expect(
    store.createVersion("p", { name: "Named" }, files),
  ).rejects.toThrow("Local version saved");
  expect(await local.listVersions("p")).toHaveLength(1);
  expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({
    expectedTreeHash: await sha256Hex(
      new TextEncoder().encode(JSON.stringify(files)),
    ),
  });
});
it("keeps device versions readable during relay failure while reporting missing hosted history", async () => {
  globalConfig.__GALLEY_CONFIG__ = { hostedStorage: true };
  const local = new InMemoryVersionStore();
  await local.createVersion("p", { name: "Safe local" }, [
    { path: "main.typ", text: "local" },
  ]);
  const notice = vi.fn();
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  const store = createHostedHistoryVersionStore(
    local,
    () => target,
    request,
    notice,
  );
  expect((await store.listVersions("p")).map((v) => v.name)).toEqual([
    "Safe local",
  ]);
  expect(notice).toHaveBeenCalledTimes(1);
});

it("never fetches or restores a hosted id when the optional adapter is disabled", async () => {
  const project = new CollabProject();
  const request = vi.fn<typeof fetch>();
  try {
    expect(
      await restoreHostedHistoryVersion(
        project,
        `hosted:room:1800000000000-${"a".repeat(64)}`,
        target,
        human,
        request,
      ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  } finally {
    project.doc.destroy();
  }
});

it("merges dated local and hosted versions chronologically for correct comparison direction", async () => {
  globalConfig.__GALLEY_CONFIG__ = { hostedStorage: true };
  const local = new InMemoryVersionStore();
  const older = await local.createVersion("p", { name: "Older local" }, []);
  const newer = await local.createVersion("p", { name: "Newer local" }, []);
  Object.assign(local, {
    listVersionMetadata: async () => [
      { ...older, createdAt: 1799999999999 },
      { ...newer, createdAt: 1800000000001 },
    ],
  });
  const id = `1800000000000-${"a".repeat(64)}`;
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify([{ id, createdAt: 1800000000000, size: 10 }]),
      ),
    );
  const store = createHostedHistoryVersionStore(local, () => target, request);
  expect((await store.listVersions("p")).map((v) => v.id)).toEqual([
    older.id,
    `hosted:room:${id}`,
    newer.id,
  ]);
});
