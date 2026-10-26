/** Optional single-writer hosted bytes and immutable CRDT checkpoints. */
import type { HostedStorage, HostedCheckpoint } from "@galley/shared";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { KeyedMutex } from "./keyed-mutex.js";

const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const locks = new KeyedMutex();
export interface HostedStorageBudget {
  reserve(room: string, bytes: number): Promise<() => void>;
  release(room: string, bytes: number): void;
}
export class FsHostedStorage implements HostedStorage {
  constructor(
    private readonly root: string,
    private readonly budget: HostedStorageBudget,
    private readonly options: {
      maxVersions?: number;
      maxAgeMs?: number;
      now?: () => number;
    } = {},
  ) {}
  private dir(kind: string, room: string): string {
    if (!SAFE.test(room)) throw new Error("Invalid room");
    return join(this.root, kind, room);
  }
  private async live(room: string): Promise<void> {
    this.dir("assets", room);
    try {
      await lstat(join(this.root, "retired-rooms", `${room}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    throw new Error("Room is retired");
  }
  private async bytes(path: string): Promise<Uint8Array | undefined> {
    try {
      const st = await lstat(path);
      if (st.size > 64 * 1024 * 1024)
        throw new Error("Hosted entry exceeds 64 MiB limit");
      if (!st.isFile() || st.isSymbolicLink())
        throw new Error("Unsafe hosted entry");
      return new Uint8Array(await readFile(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
  private async syncParents(path: string): Promise<void> {
    const root = resolve(this.root);
    let dir = resolve(dirname(path));
    while (dir === root || dir.startsWith(root + "/")) {
      const handle = await open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (dir === root) return;
      dir = dirname(dir);
    }
    throw new Error("Hosted path outside storage root");
  }
  private async atomic(
    path: string,
    bytes: Uint8Array,
    installed: () => void,
  ): Promise<void> {
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      installed();
      await this.syncParents(path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  private async write(
    room: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const rollback = await this.budget.reserve(room, bytes.byteLength);
    let installed = false;
    try {
      await this.live(room);
      await this.atomic(path, bytes, () => {
        installed = true;
      });
    } catch (error) {
      // A failure after rename is ambiguous durability: preserve the charge.
      // A retry verifies the existing bytes and repeats the durability barrier.
      if (!installed) rollback();
      throw error;
    }
  }
  async putAsset(room: string, hash: string, value: Uint8Array): Promise<void> {
    if (value.byteLength > 64 * 1024 * 1024)
      throw new Error("Asset exceeds 64 MiB limit");
    const bytes = new Uint8Array(value);
    if (
      !HASH.test(hash) ||
      createHash("sha256").update(bytes).digest("hex") !== hash
    )
      throw new Error("Asset integrity mismatch");
    return locks.run(`${this.root}:${room}`, async () => {
      await this.live(room);
      const path = join(this.dir("assets", room), `${hash}.bin`);
      const prior = await this.bytes(path);
      if (prior) {
        if (createHash("sha256").update(prior).digest("hex") !== hash)
          throw new Error("Stored asset integrity mismatch");
        const file = await open(path, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await this.syncParents(path);
        return;
      }
      await mkdir(this.dir("assets", room), { recursive: true, mode: 0o700 });
      await this.write(room, path, bytes);
    });
  }
  async getAsset(room: string, hash: string): Promise<Uint8Array | undefined> {
    if (!HASH.test(hash)) throw new Error("Invalid hash");
    await this.live(room);
    const bytes = await this.bytes(
      join(this.dir("assets", room), `${hash}.bin`),
    );
    if (bytes && createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("Stored asset integrity mismatch");
    return bytes;
  }
  private async entries(room: string): Promise<HostedCheckpoint[]> {
    let names: string[];
    try {
      names = await readdir(this.dir("history", room));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: HostedCheckpoint[] = [];
    for (const name of names) {
      const m = /^(\d{13})-([a-f0-9]{64})\.bin$/.exec(name);
      if (!m) continue;
      const st = await lstat(join(this.dir("history", room), name));
      if (!st.isFile() || st.isSymbolicLink())
        throw new Error("Unsafe checkpoint");
      out.push({
        id: name.slice(0, -4),
        createdAt: Number(m[1]),
        size: st.size,
      });
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }
  private async prune(room: string, keep: number): Promise<void> {
    const cutoff =
      (this.options.now ?? Date.now)() -
      (this.options.maxAgeMs ?? 30 * 86400000);
    const all = await this.entries(room);
    for (const [i, item] of all.entries())
      if (i >= keep || item.createdAt < cutoff) {
        const path = join(this.dir("history", room), `${item.id}.bin`);
        await rm(path);
        await this.syncParents(path);
        this.budget.release(room, item.size);
      }
  }
  async checkpoint(
    room: string,
    value: Uint8Array,
  ): Promise<HostedCheckpoint | undefined> {
    const bytes = new Uint8Array(value);
    if (bytes.byteLength > 64 * 1024 * 1024)
      throw new Error("Checkpoint exceeds 64 MiB limit");
    return locks.run(`${this.root}:${room}`, async () => {
      await this.live(room);
      const max = this.options.maxVersions ?? 20;
      if (!Number.isSafeInteger(max) || max < 1 || max > 1000)
        throw new Error("Invalid version limit");
      const hash = createHash("sha256").update(bytes).digest("hex");
      await this.prune(room, max);
      const latest = (await this.entries(room))[0];
      if (latest?.id.endsWith(hash)) {
        const path = join(this.dir("history", room), `${latest.id}.bin`);
        const existing = await this.bytes(path);
        if (
          !existing ||
          existing.byteLength !== bytes.byteLength ||
          createHash("sha256").update(existing).digest("hex") !== hash
        )
          throw new Error("Stored checkpoint integrity mismatch");
        const file = await open(path, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await this.syncParents(path);
        return latest;
      }
      // Keep the previous retained set until the replacement is durably installed.
      const createdAt = Math.max(
        (this.options.now ?? Date.now)(),
        (latest?.createdAt ?? 0) + 1,
      );
      const id = `${String(createdAt).padStart(13, "0")}-${hash}`;
      await mkdir(this.dir("history", room), { recursive: true, mode: 0o700 });
      await this.write(
        room,
        join(this.dir("history", room), `${id}.bin`),
        bytes,
      );
      await this.prune(room, max);
      return { id, createdAt, size: bytes.byteLength };
    });
  }
  async listCheckpoints(room: string): Promise<HostedCheckpoint[]> {
    return locks.run(`${this.root}:${room}`, async () => {
      await this.live(room);
      await this.prune(room, this.options.maxVersions ?? 20);
      return this.entries(room);
    });
  }
  async getCheckpoint(
    room: string,
    id: string,
  ): Promise<Uint8Array | undefined> {
    if (!/^\d{13}-[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid checkpoint");
    const entries = await this.listCheckpoints(room);
    if (!entries.some((item) => item.id === id)) return undefined;
    const bytes = await this.bytes(
      join(this.dir("history", room), `${id}.bin`),
    );
    if (
      bytes &&
      createHash("sha256").update(bytes).digest("hex") !== id.slice(14)
    )
      throw new Error("Checkpoint integrity mismatch");
    return bytes;
  }
  async retire(room: string): Promise<void> {
    this.dir("assets", room);
    return locks.run(`${this.root}:${room}`, async () => {
      // FsCrdtStore writes the common tombstone before this barrier; standalone callers do too.
      await mkdir(join(this.root, "retired-rooms"), {
        recursive: true,
        mode: 0o700,
      });
      await this.atomic(
        join(this.root, "retired-rooms", `${room}.json`),
        new TextEncoder().encode('{"version":1,"retired":true}'),
        () => undefined,
      );
      for (const kind of ["assets", "history"]) {
        const path = this.dir(kind, room);
        await rm(path, { recursive: true, force: true });
        try {
          await this.syncParents(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    });
  }
}
