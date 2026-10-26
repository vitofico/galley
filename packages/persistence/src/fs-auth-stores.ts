/**
 * Durable filesystem auth stores (roadmap #4 follow-up, ADR-0018 §3). Sessions +
 * OIDC login-state as JSON files under a root dir — so they survive a restart AND
 * can be shared across containers via a mounted volume (this is what lets
 * `apps/sync` validate a session minted by `apps/web-server`; in-memory stores
 * can't cross processes). node:fs only, no new dep.
 *
 * SECURITY: the id/state key in `getValid`/`consume`/`get` is UNTRUSTED (it comes
 * from a request cookie / callback query). It is used as a filename, so we reject
 * anything that isn't a base64url token (no `.`/`/`/`\`/NUL → no path traversal)
 * BEFORE touching the disk.
 */
import { randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  rename,
  open,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  OidcLoginState,
  OidcLoginStateStore,
  SessionRecord,
  SessionStore,
} from "@galley/shared";
import { KeyedMutex } from "./keyed-mutex.js";

/** Session/state ids are high-entropy base64url tokens — anything else is rejected. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function newToken(): string {
  return randomBytes(32).toString("base64url"); // 256-bit, filesystem-/URL-safe
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

export class FsSessionStore implements SessionStore {
  private readonly lock = new KeyedMutex();
  constructor(
    private readonly root: string,
    private readonly newId: () => string = newToken,
    private readonly accountFenceRoot?: string,
  ) {}

  private file(id: string): string {
    return join(this.root, "sessions", `${id}.json`);
  }

  async create(
    record: SessionRecord,
  ): Promise<{ id: string; record: SessionRecord }> {
    if (await this.isUserClosed(record.userId))
      throw new Error("Account is closed");
    const id = this.newId();
    await mkdir(join(this.root, "sessions"), { recursive: true });
    await this.lock.run(id, () => writeJsonAtomic(this.file(id), record));
    if (await this.isUserClosed(record.userId)) {
      await this.delete(id);
      throw new Error("Account is closed");
    }
    return { id, record };
  }

  async get(id: string): Promise<SessionRecord | null> {
    if (!SAFE_KEY.test(id)) return null; // untrusted → reject before any fs access
    return readJson<SessionRecord>(this.file(id));
  }

  async getValid(id: string, nowMs: number): Promise<SessionRecord | null> {
    if (!SAFE_KEY.test(id)) return null;
    const rec = await readJson<SessionRecord>(this.file(id));
    if (!rec) return null;
    if (await this.isUserClosed(rec.userId)) {
      await this.delete(id);
      return null;
    }
    // Fail closed on a MALFORMED expiry (#1 slice 2 session re-audit): a record
    // whose `expiresAtMs` is missing, non-numeric, NaN, or INFINITE (JSON
    // `1e999` parses to Infinity — security round M3) would otherwise compare
    // its way past every `nowMs` and validate FOREVER — an immortal session
    // minted by a corrupt/foreign file on the shared volume. Only a FINITE,
    // still-future number validates.
    if (!Number.isFinite(rec.expiresAtMs) || rec.expiresAtMs <= nowMs) {
      await this.delete(id); // reap on access
      return null;
    }
    return rec;
  }

  async delete(id: string): Promise<void> {
    if (!SAFE_KEY.test(id)) return;
    await this.lock.run(id, () => rm(this.file(id), { force: true }));
  }

  async deleteExpired(nowMs: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(join(this.root, "sessions"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const rec = await readJson<SessionRecord>(this.file(id));
      // Mirror `getValid`'s predicate exactly: a non-finite expiry (JSON `1e999`
      // → Infinity, or a corrupt/hand-placed file on the shared volume) is inert
      // — `getValid` rejects it on every access — but the sweep used to skip it,
      // so it lingered forever. Reap it too.
      if (
        rec &&
        (!Number.isFinite(rec.expiresAtMs) || rec.expiresAtMs <= nowMs)
      ) {
        await this.delete(id);
      }
    }
  }
  private accountFile(userId: string, root = this.root): string {
    return join(
      root,
      "closed-accounts",
      `${createHash("sha256").update(userId).digest("hex")}.json`,
    );
  }
  async isUserClosed(userId: string): Promise<boolean> {
    return (
      (await this.accountClosure(userId)) !== null ||
      (this.accountFenceRoot !== undefined &&
        (await readJson(this.accountFile(userId, this.accountFenceRoot))) !==
          null)
    );
  }
  async accountClosure(
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    return readJson(this.accountFile(userId));
  }
  async closeUser(
    userId: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(join(this.root, "closed-accounts"), {
      recursive: true,
      mode: 0o700,
    });
    await this.lock.run(
      `account:${createHash("sha256").update(userId).digest("hex")}`,
      async () => {
        const prior = await this.accountClosure(userId);
        if (prior && prior.operationId !== record.operationId)
          throw new Error("Account closure conflict");
        await writeJsonAtomic(this.accountFile(userId), record);
      },
    );
    await this.revokeUser(userId);
  }
  async revokeUser(userId: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(join(this.root, "sessions"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || !SAFE_KEY.test(name.slice(0, -5)))
        continue;
      const id = name.slice(0, -5);
      const record = await readJson<SessionRecord>(this.file(id));
      if (record?.userId === userId) await this.delete(id);
    }
  }
}

export class FsOidcLoginStateStore implements OidcLoginStateStore {
  constructor(private readonly root: string) {}

  private file(state: string): string {
    return join(this.root, "login-state", `${state}.json`);
  }

  async put(state: OidcLoginState): Promise<void> {
    await mkdir(join(this.root, "login-state"), { recursive: true });
    await writeJsonAtomic(this.file(state.state), state);
  }

  async consume(state: string, nowMs: number): Promise<OidcLoginState | null> {
    if (!SAFE_KEY.test(state)) return null; // untrusted callback param
    const found = await readJson<OidcLoginState>(this.file(state));
    // ALWAYS burn (even if expired/missing) — a state can never be replayed.
    await rm(this.file(state), { force: true });
    if (!found || found.expiresAtMs <= nowMs) return null;
    return found;
  }
}
