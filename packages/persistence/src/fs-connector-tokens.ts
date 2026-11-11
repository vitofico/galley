/**
 * Durable filesystem store for hosted-connector tokens (ADR-0033 §3). One JSON
 * file per token under `$GALLEY_DATA_DIR/connector-tokens/<sha256>.json`, on
 * the shared data volume: the web-server writes it when a person creates or
 * revokes a token, the connector service reads it to check one.
 *
 * The filename is the token's HASH, never the token, so the volume (and any
 * backup of it) holds nothing a client could present. Every entry point
 * validates the hash before a path is built; a malformed or mis-filed file
 * parses to null and can never authorize anything.
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
  isConnectorTokenHash,
  type ConnectorTokenRecord,
  type ConnectorTokenStore,
} from "@galley/shared";

const SUBDIR = "connector-tokens";

export class FsConnectorTokenStore implements ConnectorTokenStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, SUBDIR);
  }

  /** ONLY call with an already-validated hash. */
  private file(hash: string): string {
    return join(this.dir(), `${hash}.json`);
  }

  async get(hash: string): Promise<ConnectorTokenRecord | null> {
    if (!isConnectorTokenHash(hash)) return null;
    let raw: string;
    try {
      raw = await readFile(this.file(hash), "utf8");
    } catch {
      return null; // absent or unreadable: no record
    }
    try {
      const parsed = JSON.parse(raw) as ConnectorTokenRecord | null;
      // Filename↔record binding: a record filed under another hash is foreign.
      return typeof parsed === "object" &&
        parsed !== null &&
        parsed.hash === hash
        ? parsed
        : null;
    } catch {
      return null; // a truncated file is not a record
    }
  }

  async put(record: ConnectorTokenRecord): Promise<void> {
    if (!isConnectorTokenHash(record.hash))
      throw new Error("connector-token store: invalid hash");
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    const path = this.file(record.hash);
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, path);
  }

  async list(): Promise<ConnectorTokenRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: ConnectorTokenRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.get(name.slice(0, -5));
      if (record !== null) out.push(record);
    }
    return out;
  }

  async remove(hash: string): Promise<void> {
    if (!isConnectorTokenHash(hash)) return;
    await rm(this.file(hash), { force: true });
  }
}
