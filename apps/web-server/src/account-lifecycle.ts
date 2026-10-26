import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import {
  FsProjectStore,
  FsGroupStore,
  FsCapabilityRoomRegistry,
  FsSessionStore,
} from "@galley/persistence";
import type { Project, CapabilityRoomRecord } from "@galley/shared";

const safe = /^[A-Za-z0-9_-]{1,128}$/;
const locks = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const result = (locks.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(fn);
  locks.set(key, result);
  try {
    return await result;
  } finally {
    if (locks.get(key) === result) locks.delete(key);
  }
}
async function names(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((n) => safe.test(n)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export interface AccountLifecycleOptions {
  dataDir: string;
  sessionDir: string;
  persistDir: string;
  /** Must drain the live relay and durably retire its room before acknowledging. */
  retireRoom(room: string): Promise<void>;
}
export class AccountClosureConflict extends Error {}
interface Inventory {
  projects: Project[];
  owned: Project[];
  rooms: CapabilityRoomRecord[];
  groups: string[];
  shared: string[];
  blockers: string[];
}

/** Generic self-host account lifecycle. Commercial terms and identity-provider administration stay outside core. */
export class FsAccountLifecycle {
  private readonly projects: FsProjectStore;
  private readonly groups: FsGroupStore;
  private readonly rooms: FsCapabilityRoomRegistry;
  readonly sessions: FsSessionStore;
  constructor(private readonly options: AccountLifecycleOptions) {
    this.projects = new FsProjectStore(options.dataDir);
    this.groups = new FsGroupStore(options.dataDir);
    this.rooms = new FsCapabilityRoomRegistry(options.dataDir);
    this.sessions = new FsSessionStore(
      options.sessionDir,
      undefined,
      options.dataDir,
    );
  }
  private async inventory(subject: string): Promise<Inventory> {
    const all: Project[] = [];
    for (const id of await names(join(this.options.dataDir, "projects"))) {
      const p = await this.projects.getProject(id);
      if (p) all.push(p);
    }
    const projects = [];
    for (const p of all)
      if (
        p.ownerId === subject ||
        (await this.projects.getMembership(p.id, subject))
      )
        projects.push(p);
    const owned = all.filter((p) => p.ownerId === subject && !p.ownerGroupId);
    const rooms = (await this.rooms.list()).filter(
      (r) => r.createdBy === subject,
    );
    const shared = rooms.filter((r) => r.kind === "share").map((r) => r.roomId);
    for (const p of owned)
      if (
        (await this.projects.listMembers(p.id)).some(
          (m) => m.userId !== subject,
        )
      )
        shared.push(p.id);
    const groups = [];
    const blockers = [];
    for (const group of await this.groups.listGroupsForUser(subject)) {
      groups.push(group.id);
      const members = await this.groups.listMembers(group.id);
      if (
        members.some((m) => m.userId === subject && m.role === "admin") &&
        !members.some((m) => m.userId !== subject && m.role === "admin") &&
        (members.length > 1 || all.some((p) => p.ownerGroupId === group.id))
      )
        blockers.push(group.id);
    }
    return { projects, owned, rooms, groups, shared, blockers };
  }
  async preflight(
    subject: string,
  ): Promise<{ shared: string[]; transferGroups: string[]; closed: boolean }> {
    const i = await this.inventory(subject);
    return {
      shared: i.shared,
      transferGroups: i.blockers,
      closed: await this.sessions.isUserClosed(subject),
    };
  }
  async status(subject: string): Promise<Record<string, unknown> | null> {
    return (
      (await this.sessions.accountClosure(subject)) ??
      (await new FsSessionStore(this.options.dataDir).accountClosure(subject))
    );
  }
  async close(
    subject: string,
    operationId: string,
    deleteOwnedShared: boolean,
  ): Promise<Record<string, unknown>> {
    return serial(subject, async () => {
      const prior = await this.status(subject);
      if (prior) {
        if (prior.operationId !== operationId)
          throw new AccountClosureConflict("Operation conflict");
        if (
          prior.state === "closed" &&
          deleteOwnedShared &&
          prior.deleteOwnedShared !== true
        ) {
          const inventory = await this.inventory(subject);
          if (inventory.blockers.length)
            throw new AccountClosureConflict(
              "Transfer group administration first",
            );
          const consent = { ...prior, deleteOwnedShared: true };
          await new FsSessionStore(this.options.dataDir).closeUser(
            subject,
            consent,
          );
          await this.sessions.closeUser(subject, consent);
          return consent;
        }
        return prior;
      }
      const i = await this.inventory(subject);
      if (i.blockers.length || (i.shared.length && !deleteOwnedShared))
        throw new AccountClosureConflict(
          "Transfer sole group administration or explicitly confirm deletion of owned shared data",
        );
      const record = {
        version: 1,
        operationId,
        state: "closed",
        subjectHash: createHash("sha256").update(subject).digest("hex"),
        projectIds: i.owned.map((p) => p.id),
        roomIds: i.rooms.map((r) => r.roomId),
        closedAt: Date.now(),
        deleteOwnedShared,
      };
      // Commit the authentication fence before touching sessions, rooms, or content.
      await new FsSessionStore(this.options.dataDir).closeUser(subject, record);
      await this.sessions.closeUser(subject, record);
      for (const r of i.rooms)
        await this.rooms.put({
          ...r,
          revokedAtMs: Date.now(),
          revokedBy: subject,
        });
      return record;
    });
  }
  async purge(
    subject: string,
    operationId: string,
  ): Promise<Record<string, unknown>> {
    return serial(subject, async () => {
      const record = await this.status(subject);
      if (!record || record.operationId !== operationId)
        throw new AccountClosureConflict(
          "Close with the same operation before purging",
        );
      if (record.state === "purged") return record;
      const i = await this.inventory(subject);
      if (
        i.blockers.length ||
        (i.shared.length && record.deleteOwnedShared !== true)
      )
        throw new AccountClosureConflict(
          "New shared data requires fresh explicit consent or transfer",
        );
      // Late in-flight registrations are included; closed creators cannot authorize them.
      const projectIds = new Set([
        ...(record.projectIds as string[]),
        ...i.owned.map((p) => p.id),
      ]);
      const roomIds = new Set([
        ...(record.roomIds as string[]),
        ...i.rooms.map((r) => r.roomId),
      ]);
      for (const id of [...projectIds, ...roomIds]) {
        if (!safe.test(id)) throw new Error("Invalid closure inventory");
      }
      for (const id of projectIds) {
        // The project writer lock covers the final ownership check, relay barrier and deletion.
        const deleted = await this.projects.purgeOwnedProject(
          id,
          subject,
          record.deleteOwnedShared === true,
          () => this.options.retireRoom(id),
        );
        if (deleted)
          await rm(join(this.options.dataDir, "git", id), {
            recursive: true,
            force: true,
          });
      }
      for (const id of roomIds) {
        await this.options.retireRoom(id);
        await this.rooms.remove(id);
      }
      for (const p of i.projects)
        if (p.ownerId !== subject || p.ownerGroupId)
          await this.projects.removeMember(p.id, subject);
      for (const id of i.groups) {
        await this.groups.removeAccountMember(id, subject);
      }
      // Keep only an irreversible, hashed fence and idempotent receipt. Backups must replay it.
      const receipt = {
        version: 1,
        operationId,
        state: "purged",
        subjectHash: record.subjectHash,
        closedAt: record.closedAt,
        purgedAt: Date.now(),
      };
      await this.sessions.closeUser(subject, receipt);
      await new FsSessionStore(this.options.dataDir).closeUser(
        subject,
        receipt,
      );
      return receipt;
    });
  }
  async *export(subject: string): AsyncGenerator<string> {
    const i = await this.inventory(subject);
    yield JSON.stringify({
      format: "galley-account-ndjson",
      version: 1,
      exportedAt: Date.now(),
      projects: i.projects,
      groups: i.groups,
      capabilityRooms: i.rooms,
    }) + "\n";
    for (const p of i.owned) {
      yield JSON.stringify({
        type: "project-members",
        projectId: p.id,
        members: await this.projects.listMembers(p.id),
      }) + "\n";
      yield* this.files(
        join(this.options.dataDir, "git", p.id),
        `versions/${p.id}`,
      );
    }
    for (const id of new Set([
      ...i.owned.map((p) => p.id),
      ...i.rooms.map((r) => r.roomId),
    ])) {
      for (const kind of ["crdt", "assets", "history"])
        yield* this.files(
          join(this.options.persistDir, kind, id),
          `${kind}/${id}`,
        );
    }
    yield '{"type":"core-export-complete"}\n';
  }
  private async *files(root: string, label: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink())
        throw new Error("Export refuses symbolic links");
      const path = join(root, entry.name);
      const name = `${label}/${entry.name}`;
      if (entry.isDirectory()) {
        yield* this.files(path, name);
        continue;
      }
      if (!entry.isFile() || !(await lstat(path)).isFile())
        throw new Error("Unsupported export entry");
      yield JSON.stringify({ type: "file", path: name }) + "\n";
      for await (const bytes of createReadStream(path, {
        highWaterMark: 48 * 1024,
      }))
        yield JSON.stringify({
          type: "chunk",
          path: name,
          base64: Buffer.from(bytes).toString("base64"),
        }) + "\n";
    }
  }
}

export function createAccountLifecycleRouter(
  service: FsAccountLifecycle,
  key: Uint8Array,
): Hono {
  if (key.byteLength !== 32)
    throw new Error("Account lifecycle key must contain 32 bytes");
  const expected = Buffer.from(
    `Bearer ${Buffer.from(key).toString("base64url")}`,
  );
  const app = new Hono();
  app.post("/:action", async (c) => {
    c.header("Cache-Control", "no-store");
    const supplied = Buffer.from(c.req.header("Authorization") ?? "");
    if (
      c.req.header("Cookie") ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return c.json({ error: "unauthorized" }, 401);
    if (!c.req.raw.body) return c.json({ error: "invalid_request" }, 400);
    const reader = c.req.raw.body.getReader();
    let raw = "";
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return c.json({ error: "request_too_large" }, 413);
        }
        raw += new TextDecoder().decode(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    let body: {
      subject?: unknown;
      operationId?: unknown;
      deleteOwnedShared?: unknown;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (
      !body ||
      typeof body.subject !== "string" ||
      body.subject.length < 1 ||
      body.subject.length > 512 ||
      /[\x00-\x1f]/.test(body.subject)
    )
      return c.json({ error: "invalid_subject" }, 400);
    try {
      switch (c.req.param("action")) {
        case "preflight":
          return c.json(await service.preflight(body.subject));
        case "status":
          return c.json(await service.status(body.subject));
        case "export": {
          const generator = service.export(body.subject);
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await generator.next();
                if (next.done) controller.close();
                else controller.enqueue(encoder.encode(next.value));
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel() {
              await generator.return(undefined);
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "application/x-ndjson",
              "cache-control": "no-store",
              "content-disposition":
                'attachment; filename="galley-account.ndjson"',
            },
          });
        }
        case "close":
        case "purge": {
          if (
            typeof body.operationId !== "string" ||
            !safe.test(body.operationId)
          )
            return c.json({ error: "invalid_operation" }, 400);
          return c.json(
            c.req.param("action") === "close"
              ? await service.close(
                  body.subject,
                  body.operationId,
                  body.deleteOwnedShared === true,
                )
              : await service.purge(body.subject, body.operationId),
          );
        }
        default:
          return c.json({ error: "not_found" }, 404);
      }
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof AccountClosureConflict
              ? "closure_conflict"
              : "lifecycle_pending",
        },
        error instanceof AccountClosureConflict ? 409 : 503,
      );
    }
  });
  return app;
}

export async function readLifecycleKey(path: string): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("Lifecycle key must be a private regular file");
  const key = await readFile(path);
  if (key.byteLength !== 32)
    throw new Error("Lifecycle key must contain 32 bytes");
  return key;
}
