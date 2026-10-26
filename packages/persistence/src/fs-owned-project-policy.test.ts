import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsCapabilityRoomRegistry } from "./fs-capability-rooms.js";
it("serializes new shared projects across registry instances and allows revocation after downgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "galley-owned-cap-"));
  try {
    let limit: number | null = 3;
    let closed = false;
    const registry = () =>
      new FsCapabilityRoomRegistry(
        root,
        async () => closed,
        async () => limit,
      );
    const record = (n: number) => ({
      version: 1 as const,
      roomId: `share-${String(n).padStart(64, "0")}`,
      kind: "share" as const,
      createdBy: "alice",
      createdAtMs: 1000,
      projectId: `p${n}`,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, n) => registry().put(record(n))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    limit = null;
    await registry().put(record(4));
    limit = 0;
    await registry().put({
      ...record(0),
      revokedAtMs: 2000,
      revokedBy: "alice",
    });
    closed = true;
    await expect(registry().put(record(5))).rejects.toThrow("closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
