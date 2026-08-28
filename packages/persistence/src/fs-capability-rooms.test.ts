/**
 * FsCapabilityRoomRegistry (#1 slice 2): the durable per-room JSON registry on
 * the shared data volume. Pins the cross-container property (a record written
 * by one instance reads back from a second instance at the same dir — the
 * web-server→relay path), the traversal-proof filename gate, tombstone
 * round-trips, and the fail-closed handling of garbage files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsCapabilityRoomRegistry } from "./fs-capability-rooms.js";
import type { CapabilityRoomRecord } from "@galley/shared";

const ROOM = "share-0123456789abcdef0123456789abcdef";

function record(
  over: Partial<CapabilityRoomRecord> = {},
): CapabilityRoomRecord {
  return {
    version: 1,
    roomId: ROOM,
    kind: "share",
    createdBy: "user-1",
    createdAtMs: 1000,
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "galley-caprooms-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FsCapabilityRoomRegistry", () => {
  it("round-trips a record, and a SECOND instance at the same dir reads it (cross-container)", async () => {
    const web = new FsCapabilityRoomRegistry(dir);
    await web.put(record());
    const sync = new FsCapabilityRoomRegistry(dir); // separate instance = the relay container
    expect(await sync.get(ROOM)).toEqual(record());
  });

  it("get() of an absent or invalid id is null — and never touches a path for invalid ids", async () => {
    const reg = new FsCapabilityRoomRegistry(dir);
    expect(await reg.get(ROOM)).toBeNull();
    expect(await reg.get("../../etc/passwd")).toBeNull();
    expect(await reg.get("share-../../../escape00")).toBeNull();
    expect(await reg.get("share-aaaaaaaaaaaaaaaa%2e%2e")).toBeNull();
    expect(await reg.get("not-a-capability")).toBeNull();
  });

  it("put() throws on an invalid roomId (a hostile filename is a caller bug)", async () => {
    const reg = new FsCapabilityRoomRegistry(dir);
    await expect(
      reg.put(record({ roomId: "share-../../../../tmp/evil" })),
    ).rejects.toThrow();
    await expect(reg.put(record({ roomId: "plain-room" }))).rejects.toThrow();
    // Nothing was created on disk.
    await expect(readdir(join(dir, "capability-rooms"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("revoke = put a tombstone; the tombstone survives and lists", async () => {
    const reg = new FsCapabilityRoomRegistry(dir);
    await reg.put(record());
    await reg.put(record({ revokedAtMs: 2000, revokedBy: "user-1" }));
    const back = await reg.get(ROOM);
    expect(back?.revokedAtMs).toBe(2000);
    expect((await reg.list()).map((r) => r.roomId)).toEqual([ROOM]);
  });

  it("list() skips malformed files and foreign filenames (they never become records)", async () => {
    const reg = new FsCapabilityRoomRegistry(dir);
    await reg.put(record());
    const sub = join(dir, "capability-rooms");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "share-bbbbbbbbbbbbbbbb.json"), "{ truncated");
    await writeFile(
      join(sub, "share-cccccccccccccccc.json"),
      JSON.stringify([1, 2]),
    );
    await writeFile(join(sub, "README.txt"), "not a record");
    await writeFile(
      join(sub, "evil.json"),
      JSON.stringify(record({ roomId: "evil" })),
    );
    const listed = await reg.list();
    expect(listed.map((r) => r.roomId)).toEqual([ROOM]);
    // And a direct read of the garbage parses to null, not a throw.
    expect(await reg.get("share-bbbbbbbbbbbbbbbb")).toBeNull();
  });

  it("rejects a record whose embedded roomId disagrees with its FILENAME (LOW-2 binding)", async () => {
    const reg = new FsCapabilityRoomRegistry(dir);
    const sub = join(dir, "capability-rooms");
    await mkdir(sub, { recursive: true });
    // A mis-filed (copied/renamed/hostile) payload: the file is named one valid
    // capability id but the record inside claims ANOTHER.
    const misfiled = "share-misfiledname000000000000000000";
    await writeFile(join(sub, `${misfiled}.json`), JSON.stringify(record())); // record.roomId === ROOM
    expect(await reg.get(misfiled)).toBeNull(); // must not authorize the filename id
    expect(await reg.get(ROOM)).toBeNull(); // and must not smuggle the embedded id either
    expect(await reg.list()).toEqual([]); // nor ride into cap counts / GC
  });

  it("list() on a fresh dir is empty; remove() is idempotent and id-gated", async () => {
    const reg = new FsCapabilityRoomRegistry(dir);
    expect(await reg.list()).toEqual([]);
    await reg.remove(ROOM); // absent → no-op
    await reg.put(record());
    await reg.remove("share-../../escape0000"); // invalid → no-op, no throw
    expect((await reg.list()).length).toBe(1);
    await reg.remove(ROOM);
    expect(await reg.list()).toEqual([]);
  });
});
