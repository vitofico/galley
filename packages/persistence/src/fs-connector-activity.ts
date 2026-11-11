/**
 * The hosted connector's activity trail on disk (ADR-0033 §4): one JSON-lines
 * file per connected project's room under `<root>/activity/<room>.jsonl`. The
 * connector service is the only writer; the web app reads it for the owner.
 *
 * Append-only in normal use: an entry is one `appendFile` of one line, synced
 * before the call returns, because the connector applies a change only after
 * its `started` entry is safely on disk. The file is bounded: once it grows
 * past {@link COMPACT_BYTES} it is rewritten (atomically) with the newest
 * entries. Dropping old entries is safe here: the trail is a record for a
 * person to read, not a replay guard.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  CONNECTOR_ACTIVITY_LIMITS,
  isConnectorCheckpointId,
  parseConnectorActivityEntry,
  type ConnectorActivityEntry,
} from "@galley/shared";
import { KeyedMutex } from "./keyed-mutex.js";

const SAFE_ROOM = /^[A-Za-z0-9_-]{1,128}$/;
/** Size at which a trail is rewritten with its newest entries. */
const COMPACT_BYTES = 1024 * 1024;
const locks = new KeyedMutex();

export class FsConnectorActivityLog {
  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, "activity");
  }

  private file(room: string): string {
    if (!SAFE_ROOM.test(room)) throw new Error("Invalid room");
    return join(this.dir(), `${room}.jsonl`);
  }

  /** Every readable entry, oldest first. A missing file is an empty trail. */
  async read(room: string): Promise<ConnectorActivityEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(room), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: ConnectorActivityEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      try {
        const entry = parseConnectorActivityEntry(JSON.parse(line));
        if (entry !== null) out.push(entry);
      } catch {
        // A torn last line (a crash mid-append) is not an entry.
      }
    }
    return out;
  }

  /** Add one entry and sync it to disk. Throws if it cannot be stored. */
  async append(room: string, entry: ConnectorActivityEntry): Promise<void> {
    if (parseConnectorActivityEntry(entry) === null)
      throw new Error("connector activity: invalid entry");
    const path = this.file(room);
    await locks.run(`${this.root}:${room}`, async () => {
      await mkdir(this.dir(), { recursive: true, mode: 0o700 });
      const handle = await open(path, "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await stat(path)).size > COMPACT_BYTES) await this.compact(room);
    });
  }

  private async compact(room: string): Promise<void> {
    const path = this.file(room);
    let kept = (await this.read(room)).slice(
      -CONNECTOR_ACTIVITY_LIMITS.maxEntries,
    );
    const render = () => kept.map((e) => `${JSON.stringify(e)}\n`).join("");
    let text = render();
    // Long paths can keep even the newest entries over the bound: halve until under.
    while (text.length > COMPACT_BYTES / 2 && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 2));
      text = render();
    }
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  }
}

/** A checkpoint larger than this is refused, and with it the change. */
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;

/**
 * The checkpoints behind the trail: `<root>/checkpoints/<room>/<id>.json`, one
 * immutable file per change, written by the connector before it applies. Only
 * the newest `keep` are retained per project. Reading never writes, so the web
 * app can mount the volume read-only.
 */
export class FsConnectorCheckpoints {
  constructor(
    private readonly root: string,
    private readonly options: { keep?: number; now?: () => number } = {},
  ) {}

  private dir(room: string): string {
    if (!SAFE_ROOM.test(room)) throw new Error("Invalid room");
    return join(this.root, "checkpoints", room);
  }

  /** Ids on disk, newest first. */
  async list(room: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(room));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".json") && isConnectorCheckpointId(n.slice(0, -5)))
      .map((n) => n.slice(0, -5))
      .sort()
      .reverse();
  }

  /** Store one checkpoint durably and return its id. Throws if it cannot. */
  async save(room: string, bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > MAX_CHECKPOINT_BYTES)
      throw new Error("connector checkpoint: too large");
    const dir = this.dir(room);
    return locks.run(`${this.root}:${room}`, async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const existing = await this.list(room);
      // Strictly increasing, so ids sort in the order they were taken.
      const at = Math.max(
        (this.options.now ?? Date.now)(),
        Number(existing[0]?.slice(0, 13) ?? 0) + 1,
      );
      const id = `${String(at).padStart(13, "0")}-${createHash("sha256").update(bytes).digest("hex")}`;
      const path = join(dir, `${id}.json`);
      const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
      const keep = this.options.keep ?? 50;
      for (const old of existing.slice(Math.max(0, keep - 1)))
        await rm(join(dir, `${old}.json`), { force: true });
      return id;
    });
  }

  /** The stored bytes, or null when absent or no longer what was stored. */
  async read(room: string, id: string): Promise<Uint8Array | null> {
    if (!isConnectorCheckpointId(id)) return null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(this.dir(room), `${id}.json`)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return createHash("sha256").update(bytes).digest("hex") === id.slice(14)
      ? bytes
      : null;
  }
}
