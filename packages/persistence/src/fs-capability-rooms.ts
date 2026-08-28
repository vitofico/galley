/**
 * Durable filesystem capability-room registry (#1 slice 2). One JSON file per
 * room under `$GALLEY_DATA_DIR/capability-rooms/<roomId>.json`, on the SAME
 * shared data volume the sync relay mounts — so a registration written by the
 * web-server is visible to the relay's upgrade gate with no extra service
 * (exactly the `FsSessionStore` cross-container pattern).
 *
 * SECURITY: `roomId` is UNTRUSTED everywhere it arrives (a request body, a URL
 * param, a ws room path) and it becomes a FILENAME here. Every entry point
 * validates it with the shared `isCapabilityRoomId` namespace gate (no `.`,
 * `/`, `\`, `%`, NUL; bounded length) BEFORE any path is built — reads of an
 * invalid id resolve null, writes throw. Malformed/garbage files on the volume
 * parse to null/are skipped, so they can never authorize anything.
 */
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import {
  isCapabilityRoomId,
  type CapabilityRoomRecord,
  type CapabilityRoomStore,
} from "@galley/shared";
import { KeyedMutex } from "./keyed-mutex.js";

const SUBDIR = "capability-rooms";

export class FsCapabilityRoomRegistry implements CapabilityRoomStore {
  private readonly lock = new KeyedMutex();

  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, SUBDIR);
  }

  /** ONLY call with an already-validated id (every public method gates first). */
  private file(roomId: string): string {
    return join(this.dir(), `${roomId}.json`);
  }

  async get(roomId: string): Promise<CapabilityRoomRecord | null> {
    if (!isCapabilityRoomId(roomId)) return null; // untrusted → reject before any fs access
    const record = await readRecord(this.file(roomId));
    // Filename↔record binding (security round, LOW): a record whose embedded
    // roomId disagrees with the file it was read from is foreign/corrupt — it
    // must neither authorize the REQUESTED id nor smuggle a different one.
    if (record !== null && record.roomId !== roomId) return null;
    return record;
  }

  async put(record: CapabilityRoomRecord): Promise<void> {
    if (!isCapabilityRoomId(record.roomId)) {
      // A write with a hostile id is a caller bug — loud, never a silent file.
      throw new Error("capability-room registry: invalid roomId");
    }
    await mkdir(this.dir(), { recursive: true });
    await this.lock.run(record.roomId, () =>
      writeJsonAtomic(this.file(record.roomId), record),
    );
  }

  async list(): Promise<CapabilityRoomRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: CapabilityRoomRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const roomId = name.slice(0, -5);
      if (!isCapabilityRoomId(roomId)) continue; // a foreign file is not a record
      const rec = await readRecord(this.file(roomId));
      // Same filename↔record binding as get(): skip mismatched records so a
      // mis-filed payload can't ride into cap counts or the GC sweep.
      if (rec !== null && rec.roomId === roomId) out.push(rec);
    }
    return out;
  }

  async remove(roomId: string): Promise<void> {
    if (!isCapabilityRoomId(roomId)) return;
    await this.lock.run(roomId, () => rm(this.file(roomId), { force: true }));
  }
}

/** Parse one record file; null for missing/unreadable/malformed (fail closed). */
async function readRecord(path: string): Promise<CapabilityRoomRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null; // ENOENT or unreadable — either way, no record
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return parsed as CapabilityRoomRecord;
  } catch {
    return null; // a truncated/garbage file is NOT a record (and never authorizes)
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}
