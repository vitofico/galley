import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { compactUpdates } from "@galley/collab";
import {
  FsCrdtStore,
  FsProjectStore,
  FsSessionStore,
  FsCapabilityRoomRegistry,
} from "@galley/persistence";
import type { StorageQuota } from "./sync-server.js";
class RoomOwnerUnavailable extends Error {}
export interface AccountStoragePolicy {
  maxBytes: number;
  expiresAt: number;
}
/** Single-relay aggregate budget across persisted and live rooms. Policy values are injected. */
export class AggregateStorageQuota implements StorageQuota {
  private readonly owners = new Map<string, string>();
  private readonly usage = new Map<string, number>();
  private readonly extraUsage = new Map<string, number>();
  private readonly gitUsage = new Map<string, number>();
  private readonly policies = new Map<string, AccountStoragePolicy>();
  private reconcileLive: (() => void) | undefined;
  attachLiveReconciler(reconcile: () => void): void {
    this.reconcileLive = reconcile;
  }
  readonly maxLogBytes?: number;
  readonly compactionFloorBytes?: number;
  private initial: Promise<void> | undefined;
  constructor(
    private readonly options: {
      dataDir: string;
      persistDir: string;
      policy(subject: string): Promise<AccountStoragePolicy>;
      now?: () => number;
      maxContentBytes?: number;
      maxLogBytes?: number;
      compactionFloorBytes?: number;
    },
  ) {
    if (options.maxLogBytes !== undefined)
      this.maxLogBytes = options.maxLogBytes;
    if (options.compactionFloorBytes !== undefined)
      this.compactionFloorBytes = options.compactionFloorBytes;
  }
  private async owner(room: string, writing = true): Promise<string> {
    const project = await new FsProjectStore(this.options.dataDir).getProject(
      room,
    );
    // A group is a separate owner and must have its own policy, never billed to a departing creator.
    if (project) {
      if (project.ownerGroupId) return `group:${project.ownerGroupId}`;
      if (
        writing &&
        (await new FsSessionStore(this.options.dataDir).isUserClosed(
          project.ownerId,
        ))
      )
        throw new Error("Room owner is closed");
      return project.ownerId;
    }
    const cap = await new FsCapabilityRoomRegistry(this.options.dataDir).get(
      room,
    );
    if (!cap || (writing && cap.revokedAtMs !== undefined))
      throw new RoomOwnerUnavailable("Room owner unavailable");
    if (
      writing &&
      (await new FsSessionStore(this.options.dataDir).isUserClosed(
        cap.createdBy,
      ))
    )
      throw new Error("Room owner is closed");
    return cap.createdBy;
  }
  private async initialize(): Promise<void> {
    const roomSet = new Set<string>();
    for (const [root, kind] of [
      [this.options.persistDir, "crdt"],
      [this.options.persistDir, "assets"],
      [this.options.persistDir, "history"],
      [this.options.dataDir, "git"],
    ] as const) {
      try {
        for (const room of await readdir(join(root, kind))) roomSet.add(room);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    const rooms = [...roomSet];
    const store = new FsCrdtStore(this.options.persistDir);
    for (const room of rooms.sort()) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(room)) continue;
      let subject: string;
      try {
        subject = await this.owner(room, false);
      } catch (error) {
        if (error instanceof RoomOwnerUnavailable) continue;
        throw error;
      } // unregistered rooms cannot admit writes
      this.owners.set(room, subject);
      this.extraUsage.set(
        room,
        (await this.diskBytes(join(this.options.persistDir, "assets", room))) +
          (await this.diskBytes(
            join(this.options.persistDir, "history", room),
          )),
      );
      this.gitUsage.set(
        room,
        await this.diskBytes(join(this.options.dataDir, "git", room)),
      );
      let retired = false;
      try {
        await lstat(
          join(this.options.persistDir, "retired-rooms", `${room}.json`),
        );
        retired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const updates = retired ? [] : await store.loadUpdates(room);
      // A live update/restore may have already supplied a newer upper bound.
      if (!this.usage.has(room))
        this.usage.set(
          room,
          updates.length ? compactUpdates(updates).byteLength : 0,
        );
    }
  }
  private async diskBytes(path: string): Promise<number> {
    let info;
    try {
      info = await lstat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    if (info.isSymbolicLink())
      throw new Error("Storage accounting refuses symbolic links");
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) throw new Error("Unsupported storage entry");
    let total = 0;
    for (const name of await readdir(path))
      total += await this.diskBytes(join(path, name));
    return total;
  }
  async reserve(room: string, bytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Invalid storage reservation");
    await this.getCaps(room);
    if (!this.allowGrowth(room, bytes)) this.reconcileLive?.();
    if (!this.allowGrowth(room, bytes))
      throw new Error("Owner storage limit reached");
    this.extraUsage.set(room, (this.extraUsage.get(room) ?? 0) + bytes);
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.release(room, bytes);
      }
    };
  }
  release(room: string, bytes: number): void {
    this.extraUsage.set(
      room,
      Math.max(0, (this.extraUsage.get(room) ?? 0) - bytes),
    );
  }
  async getCaps(room: string): Promise<{ maxContentBytes: number }> {
    if (!this.initial)
      this.initial = this.initialize().catch((error) => {
        this.initial = undefined;
        throw error;
      });
    await this.initial;
    // Ownership transfers must not keep charging an earlier owner.
    for (const id of this.owners.keys()) {
      try {
        this.owners.set(id, await this.owner(id, false));
      } catch (error) {
        if (!(error instanceof RoomOwnerUnavailable))
          throw error; /* retain prior charge until retirement */
      }
      this.gitUsage.set(
        id,
        await this.diskBytes(join(this.options.dataDir, "git", id)),
      );
    }
    const subject = await this.owner(room);
    this.owners.set(room, subject);
    const policy = await this.options.policy(subject);
    const now = (this.options.now ?? Date.now)();
    if (
      !Number.isSafeInteger(policy.maxBytes) ||
      policy.maxBytes < 0 ||
      !Number.isSafeInteger(policy.expiresAt) ||
      policy.expiresAt <= now ||
      policy.expiresAt > now + 300000
    )
      throw new Error("Invalid storage policy");
    this.policies.set(subject, policy);
    return {
      maxContentBytes: Math.min(
        policy.maxBytes,
        this.options.maxContentBytes ?? policy.maxBytes,
      ),
    };
  }
  allowGrowth(room: string, bytes: number): boolean {
    const subject = this.owners.get(room);
    if (!subject) return false;
    const policy = this.policies.get(subject);
    if (!policy || policy.expiresAt <= (this.options.now ?? Date.now)())
      return false;
    let total = 0;
    for (const id of this.owners.keys())
      if (this.owners.get(id) === subject)
        total +=
          (this.usage.get(id) ?? 0) +
          (this.extraUsage.get(id) ?? 0) +
          (this.gitUsage.get(id) ?? 0);
    return total + bytes <= policy.maxBytes;
  }
  recordContent(room: string, bytes: number): void {
    this.usage.set(room, bytes);
  }
  retire(room: string): void {
    this.usage.delete(room);
    this.extraUsage.delete(room);
    this.gitUsage.delete(room);
    this.owners.delete(room);
  }
}
