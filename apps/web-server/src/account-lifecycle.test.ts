import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsProjectStore, FsGroupStore, FsCrdtStore } from "@galley/persistence";
import {
  FsAccountLifecycle,
  createAccountLifecycleRouter,
} from "./account-lifecycle.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "galley-lifecycle-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function service(retireRoom?: (room: string) => Promise<void>) {
  const crdt = new FsCrdtStore(root);
  return new FsAccountLifecycle({
    dataDir: root,
    persistDir: root,
    sessionDir: root,
    retireRoom: retireRoom ?? ((room) => crdt.retire(room)),
  });
}
describe("account lifecycle", () => {
  it("rechecks group ownership under the project writer lock before retirement", async () => {
    const projects = new FsProjectStore(root);
    const groups = new FsGroupStore(root, () => "team");
    const retired: string[] = [];
    const s = service(async (id) => {
      retired.push(id);
    });
    await groups.createGroup("Team", "alice");
    await groups.addMember("team", "bob", "admin");
    await projects.createProject({ id: "p", name: "P", ownerId: "alice" });
    await s.close("alice", "op", false);
    // Model a transfer committed immediately before the account fence, after its inventory.
    await writeFile(
      join(root, "projects/p/project.json"),
      JSON.stringify({
        id: "p",
        name: "Team",
        ownerId: "alice",
        ownerGroupId: "team",
      }),
    );
    await s.purge("alice", "op");
    expect(retired).not.toContain("p");
    expect((await projects.getProject("p"))?.ownerGroupId).toBe("team");
    expect(await projects.getMembership("p", "alice")).toBeNull();
    await projects.updateProject("p", { name: "Still editable by the group" });
  });
  it("requires fresh consent for late sharing and fences new ownership/memberships after closure", async () => {
    const projects = new FsProjectStore(root);
    const groups = new FsGroupStore(root, () => "g");
    const s = service();
    await projects.createProject({
      id: "p",
      name: "Personal",
      ownerId: "alice",
    });
    await projects.createProject({ id: "b", name: "Bob", ownerId: "bob" });
    await groups.createGroup("Bob", "bob");
    await s.close("alice", "op", false);
    await expect(
      projects.createProject({ id: "late", name: "Late", ownerId: "alice" }),
    ).rejects.toThrow("closed");
    await expect(projects.addMember("p", "bob", "editor")).rejects.toThrow(
      "closed",
    );
    await expect(projects.addMember("b", "alice", "editor")).rejects.toThrow(
      "closed",
    );
    await expect(groups.addMember("g", "alice", "member")).rejects.toThrow(
      "closed",
    );
    // Model a metadata write already committed between preflight and the fence.
    await writeFile(
      join(root, "projects/p/members.json"),
      JSON.stringify({ alice: "owner", bob: "editor" }),
    );
    await expect(s.purge("alice", "op")).rejects.toThrow(
      "fresh explicit consent",
    );
    expect(await projects.getProject("p")).not.toBeNull();
    await s.close("alice", "op", true);
    expect((await s.purge("alice", "op")).state).toBe("purged");
  });
  it("requires explicit shared-content deletion, preserves other owners, revokes sessions and cannot recreate after restart", async () => {
    const projects = new FsProjectStore(root);
    const crdt = new FsCrdtStore(root);
    const s = service();
    await projects.createProject({
      id: "mine",
      name: "Mine",
      ownerId: "alice",
    });
    await projects.addMember("mine", "bob", "editor");
    await projects.createProject({
      id: "theirs",
      name: "Theirs",
      ownerId: "bob",
    });
    await projects.addMember("theirs", "alice", "editor");
    const session = await s.sessions.create({
      userId: "alice",
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60000,
    });
    await crdt.appendUpdate("mine", new Uint8Array([1, 2]));
    await crdt.appendUpdate("theirs", new Uint8Array([3, 4]));
    await expect(s.close("alice", "op1", false)).rejects.toThrow();
    expect(await s.sessions.getValid(session.id, Date.now())).not.toBeNull();
    await s.close("alice", "op1", true);
    expect(await s.sessions.getValid(session.id, Date.now())).toBeNull();
    const receipt = await s.purge("alice", "op1");
    expect(receipt.state).toBe("purged");
    expect(await service().purge("alice", "op1")).toEqual(receipt);
    await expect(
      service().sessions.create({
        userId: "alice",
        createdAtMs: 0,
        expiresAtMs: Date.now() + 60000,
      }),
    ).rejects.toThrow();
    await expect(
      new FsCrdtStore(root).appendUpdate("mine", new Uint8Array([5])),
    ).rejects.toThrow("retired");
    expect(await projects.getProject("mine")).toBeNull();
    expect(await projects.getProject("theirs")).not.toBeNull();
    expect(await projects.getMembership("theirs", "alice")).toBeNull();
    expect(await crdt.loadUpdates("theirs")).toEqual([new Uint8Array([3, 4])]);
    expect(JSON.stringify(receipt)).not.toContain("alice");
  });
  it("remains closed and retryable until the live relay acknowledges retirement", async () => {
    await new FsProjectStore(root).createProject({
      id: "p",
      name: "P",
      ownerId: "a",
    });
    const s = service(async () => {
      throw new Error("offline");
    });
    await s.close("a", "op", false);
    await expect(s.purge("a", "op")).rejects.toThrow("offline");
    expect((await s.status("a"))?.state).toBe("closed");
    expect(await new FsProjectStore(root).getProject("p")).not.toBeNull();
    expect((await service().purge("a", "op")).state).toBe("purged");
  });
  it("requires transferring sole group administration and retains group-owned documents", async () => {
    const groups = new FsGroupStore(root, () => "team");
    const projects = new FsProjectStore(root);
    await groups.createGroup("Team", "alice");
    await groups.addMember("team", "bob", "member");
    await projects.createProject({
      id: "teamproject",
      name: "Team",
      ownerId: "alice",
    });
    await projects.updateProject("teamproject", { ownerGroupId: "team" });
    await expect(service().close("alice", "op", true)).rejects.toThrow();
    await groups.addMember("team", "bob", "admin");
    await service().close("alice", "op", true);
    await service().purge("alice", "op");
    expect(await projects.getProject("teamproject")).not.toBeNull();
    expect(await groups.getMembership("team", "bob")).toBe("admin");
    expect(await groups.getMembership("team", "alice")).toBeNull();
  });
  it("exports owned persisted content and version history without another owner's content or credentials", async () => {
    const projects = new FsProjectStore(root);
    await projects.createProject({ id: "mine", name: "Mine", ownerId: "a" });
    await projects.createProject({ id: "other", name: "Other", ownerId: "b" });
    await projects.addMember("other", "a", "viewer");
    await mkdir(join(root, "git", "mine"), { recursive: true });
    await writeFile(join(root, "git", "mine", "history"), "version");
    await new FsCrdtStore(root).appendUpdate("mine", new Uint8Array([1, 2]));
    await new FsCrdtStore(root).appendUpdate("other", new Uint8Array([7, 8]));
    for (const kind of ["assets", "history"])
      for (const id of ["mine", "other"]) {
        await mkdir(join(root, kind, id), { recursive: true });
        await writeFile(
          join(root, kind, id, "fixture.bin"),
          new Uint8Array([3, 4, 5]),
        );
      }
    const chunks = [];
    for await (const chunk of service().export("a")) chunks.push(chunk);
    const result = chunks.join("");
    expect(result).toContain("versions/mine/history");
    expect(result).toContain("crdt/mine/updates");
    expect(result).not.toContain("crdt/other/");
    expect(result).not.toContain("sessions/");
    expect(result).toContain("assets/mine/fixture.bin");
    expect(result).toContain("history/mine/fixture.bin");
    expect(result).not.toContain("assets/other/");
    expect(result).not.toContain("history/other/");
    await service().close("a", "delete-assets", false);
    await service().purge("a", "delete-assets");
    for (const kind of ["assets", "history"]) {
      await expect(
        readFile(join(root, kind, "mine", "fixture.bin")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        new Uint8Array(
          await readFile(join(root, kind, "other", "fixture.bin")),
        ),
      ).toEqual(new Uint8Array([3, 4, 5]));
    }
  });
  it("authenticates the internal surface before parsing and requires matching operations", async () => {
    const key = new Uint8Array(32).fill(3);
    const app = createAccountLifecycleRouter(service(), key);
    const post = (body: string, authorization?: string, cookie?: string) =>
      app.request("http://test/close", {
        method: "POST",
        body,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(cookie ? { cookie } : {}),
        },
      });
    expect((await post("not-json")).status).toBe(401);
    const auth = `Bearer ${Buffer.from(key).toString("base64url")}`;
    expect(
      (
        await post(
          JSON.stringify({ subject: "a", operationId: "op" }),
          auth,
          "session=x",
        )
      ).status,
    ).toBe(401);
    expect(
      (await post(JSON.stringify({ subject: "a", operationId: "op" }), auth))
        .status,
    ).toBe(200);
    expect(
      (await post(JSON.stringify({ subject: "a", operationId: "other" }), auth))
        .status,
    ).toBe(409);
  });
});
