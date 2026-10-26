import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FsHostedStorage } from "./fs-hosted-storage.js";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
it("verifies immutable room-scoped assets, prunes retained versions and makes retirement irreversible", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-store-"));
  let used = 0,
    now = 1800000000000;
  const budget = {
    reserve: async (_room: string, n: number) => {
      used += n;
      return () => {
        used -= n;
      };
    },
    release: (_room: string, n: number) => {
      used -= n;
    },
  };
  const store = new FsHostedStorage(root, budget, {
    maxVersions: 2,
    maxAgeMs: 1000,
    now: () => now,
  });
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    await store.putAsset("alice", hash(bytes), bytes);
    await store.putAsset("alice", hash(bytes), bytes);
    expect(used).toBe(3);
    expect(await store.getAsset("bob", hash(bytes))).toBeUndefined();
    await expect(
      store.putAsset("alice", "0".repeat(64), bytes),
    ).rejects.toThrow("integrity");
    const first = await store.checkpoint("alice", new Uint8Array([1]));
    now++;
    const second = await store.checkpoint("alice", new Uint8Array([2, 2]));
    now++;
    const third = await store.checkpoint("alice", new Uint8Array([3, 3, 3]));
    expect(used).toBe(8);
    expect((await store.listCheckpoints("alice")).map((v) => v.id)).toEqual([
      third!.id,
      second!.id,
    ]);
    expect(await store.getCheckpoint("alice", first!.id)).toBeUndefined();
    now += 1001;
    expect(await store.listCheckpoints("alice")).toEqual([]);
    expect(used).toBe(3);
    await writeFile(
      join(root, "assets", "alice", `${hash(bytes)}.bin`),
      new Uint8Array([9]),
    );
    await expect(store.getAsset("alice", hash(bytes))).rejects.toThrow(
      "integrity",
    );
    await store.retire("alice");
    await expect(store.putAsset("alice", hash(bytes), bytes)).rejects.toThrow(
      "retired",
    );
    await expect(
      new FsHostedStorage(root, budget).checkpoint("alice", bytes),
    ).rejects.toThrow("retired");
    await expect(store.retire("../escape")).rejects.toThrow("Invalid room");
    expect(
      JSON.parse(
        await readFile(join(root, "retired-rooms", "alice.json"), "utf8"),
      ).retired,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("waits for an in-flight write before purging; a late write cannot resurrect a retired room", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-retire-"));
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const store = new FsHostedStorage(root, {
    reserve: async () => {
      began();
      await gate;
      return () => undefined;
    },
    release: () => undefined,
  });
  try {
    const bytes = new Uint8Array([1]);
    const pending = store.putAsset("room", hash(bytes), bytes);
    await started;
    const retire = store.retire("room");
    release();
    await pending;
    await retire;
    await expect(store.getAsset("room", hash(bytes))).rejects.toThrow(
      "retired",
    );
    await expect(store.putAsset("room", hash(bytes), bytes)).rejects.toThrow(
      "retired",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rolls back failed reservations and refuses symbolic-link entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-failure-"));
  try {
    const store = new FsHostedStorage(root, {
      reserve: async () => {
        throw new Error("Owner limit");
      },
      release: () => undefined,
    });
    await expect(
      store.putAsset("room", hash(new Uint8Array([1])), new Uint8Array([1])),
    ).rejects.toThrow("Owner limit");
    await mkdir(join(root, "history", "room"), { recursive: true });
    expect(await store.listCheckpoints("room")).toEqual([]);
    let reserved = 0;
    const interrupted = new FsHostedStorage(root, {
      reserve: async (_room, n) => {
        reserved += n;
        await mkdir(join(root, "retired-rooms"), { recursive: true });
        await writeFile(join(root, "retired-rooms", "late.json"), "{}");
        return () => {
          reserved -= n;
        };
      },
      release: () => undefined,
    });
    await expect(
      interrupted.putAsset(
        "late",
        hash(new Uint8Array([1])),
        new Uint8Array([1]),
      ),
    ).rejects.toThrow("retired");
    expect(reserved).toBe(0);
    const linked = new FsHostedStorage(root, {
      reserve: async () => () => undefined,
      release: () => undefined,
    });
    await mkdir(join(root, "assets", "linked"), { recursive: true });
    await writeFile(join(root, "secret"), new Uint8Array([1]));
    await symlink(
      join(root, "secret"),
      join(root, "assets", "linked", `${hash(new Uint8Array([1]))}.bin`),
    );
    await expect(
      linked.getAsset("linked", hash(new Uint8Array([1]))),
    ).rejects.toThrow("Unsafe hosted entry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves the last retained checkpoint when a replacement cannot reserve or persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-retention-failure-"));
  let used = 0,
    deny = false,
    now = 1800000000000;
  const store = new FsHostedStorage(
    root,
    {
      reserve: async (_room, n) => {
        if (deny) throw new Error("Owner storage limit");
        used += n;
        return () => {
          used -= n;
        };
      },
      release: (_room, n) => {
        used -= n;
      },
    },
    { maxVersions: 1, now: () => now },
  );
  try {
    const first = await store.checkpoint("room", new Uint8Array([1]));
    now++;
    deny = true;
    await expect(store.checkpoint("room", new Uint8Array([2]))).rejects.toThrow(
      "Owner storage limit",
    );
    deny = false;
    expect((await store.listCheckpoints("room")).map((c) => c.id)).toEqual([
      first!.id,
    ]);
    expect(used).toBe(1);
    const atomic = vi
      .spyOn(
        store as unknown as { atomic: (...args: unknown[]) => Promise<void> },
        "atomic",
      )
      .mockRejectedValueOnce(new Error("synthetic filesystem failure"));
    await expect(store.checkpoint("room", new Uint8Array([3]))).rejects.toThrow(
      "filesystem failure",
    );
    atomic.mockRestore();
    expect((await store.listCheckpoints("room")).map((c) => c.id)).toEqual([
      first!.id,
    ]);
    expect(used).toBe(1);
    const next = await store.checkpoint("room", new Uint8Array([4, 4]));
    expect((await store.listCheckpoints("room")).map((c) => c.id)).toEqual([
      next!.id,
    ]);
    expect(used).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("never acknowledges a same-state checkpoint retry from a corrupt stored file", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-checkpoint-integrity-"));
  const store = new FsHostedStorage(root, {
    reserve: async () => () => undefined,
    release: () => undefined,
  });
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const checkpoint = await store.checkpoint("room", bytes);
    await writeFile(
      join(root, "history", "room", `${checkpoint!.id}.bin`),
      new Uint8Array([9]),
    );
    await expect(store.checkpoint("room", bytes)).rejects.toThrow(
      "checkpoint integrity mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
