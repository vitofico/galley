/** Hosted checkpoints augment local named history; restores stay explicit human CRDT edits. */
import {
  CollabProject,
  restoreDoc,
  materializeProject,
  isValidHash,
  isValidMime,
  sha256Hex,
  BLOB_MAX_TRANSFER_BYTES,
} from "@galley/collab";
import {
  isSafeProjectPath,
  type Author,
  type Version,
  type VersionStore,
  type VersionedFile,
} from "@galley/shared";
import { restoreProjectFromTree } from "./project-session.js";
import { hostedStorageEnabled } from "./blob-session.js";
export interface HostedHistoryTarget {
  syncUrl: string;
  room: string;
}
interface Checkpoint {
  id: string;
  createdAt: number;
  size: number;
}
const ID = /^\d{13}-[a-f0-9]{64}$/;
function url(target: HostedHistoryTarget, id?: string): string {
  const base = new URL(target.syncUrl);
  if (
    !["ws:", "wss:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(target.room)
  )
    throw new Error("Invalid hosted history target");
  base.protocol = base.protocol === "wss:" ? "https:" : "http:";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/history/${target.room}${id ? `/${id}` : ""}`;
  return base.toString();
}
function hostedId(room: string, id: string): string {
  return `hosted:${room}:${id}`;
}
function parseId(
  versionId: string,
  target: HostedHistoryTarget,
): string | undefined {
  const prefix = `hosted:${target.room}:`;
  const id = versionId.startsWith(prefix) ? versionId.slice(prefix.length) : "";
  return ID.test(id) ? id : undefined;
}
async function boundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error("Hosted history unavailable");
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Hosted response too large");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
async function load(
  target: HostedHistoryTarget,
  id: string,
  request: typeof fetch,
): Promise<CollabProject> {
  const response = await request(url(target, id), {
    credentials: "include",
    cache: "no-store",
  });
  const bytes = await boundedBytes(response, BLOB_MAX_TRANSFER_BYTES);
  if ((await sha256Hex(bytes)) !== id.slice(14))
    throw new Error("Hosted checkpoint integrity mismatch");
  return new CollabProject(restoreDoc(bytes));
}
function tree(project: CollabProject): VersionedFile[] {
  const result = materializeProject(project.snapshot());
  if (!result.ok) throw new Error("Unsafe hosted checkpoint");
  return result.result.files;
}
export function createHostedHistoryVersionStore(
  local: VersionStore,
  getTarget: () => HostedHistoryTarget | undefined,
  request: typeof fetch = fetch,
  onUnavailable?: () => void,
): VersionStore {
  return {
    async createVersion(projectId, input, files) {
      const version = await local.createVersion(projectId, input, files);
      const target = hostedStorageEnabled() ? getTarget() : undefined;
      // These are canonical relay checkpoints, independently labelled from local named versions.
      if (target) {
        const saved = await request(url(target), {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedTreeHash: await sha256Hex(
              new TextEncoder().encode(JSON.stringify(files)),
            ),
          }),
        });
        if (!saved.ok)
          throw new Error("Local version saved; hosted checkpoint unavailable");
      }
      return version;
    },
    async listVersions(projectId) {
      const versions = await local.listVersions(projectId);
      const target = hostedStorageEnabled() ? getTarget() : undefined;
      if (!target) return versions;
      try {
        const response = await request(url(target), {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Hosted history unavailable");
        const value: unknown = JSON.parse(
          new TextDecoder().decode(await boundedBytes(response, 256 * 1024)),
        );
        if (!Array.isArray(value) || value.length > 1000)
          throw new Error("Invalid hosted history");
        const checkpoints = value as Checkpoint[];
        for (const item of checkpoints)
          if (
            !item ||
            typeof item.id !== "string" ||
            !ID.test(item.id) ||
            item.createdAt !== Number(item.id.slice(0, 13)) ||
            !Number.isSafeInteger(item.createdAt) ||
            !Number.isSafeInteger(item.size) ||
            item.size < 0 ||
            item.size > BLOB_MAX_TRANSFER_BYTES
          )
            throw new Error("Invalid hosted checkpoint");
        // The panel and comparison contract use oldest-first order. Merge real
        // timestamps when the local adapter exposes them; legacy rows retain
        // their insertion order before dated checkpoints.
        const metadataStore = local as VersionStore & {
          listVersionMetadata?: (
            projectId: string,
          ) => Promise<(Version & { createdAt?: number })[]>;
        };
        const metadata = metadataStore.listVersionMetadata
          ? await metadataStore.listVersionMetadata(projectId)
          : [];
        const times = new Map(
          metadata
            .filter(
              (item) =>
                typeof item.createdAt === "number" &&
                Number.isFinite(item.createdAt),
            )
            .map((item) => [item.id, item.createdAt!]),
        );
        const rows = versions.map((version, index) => ({
          version,
          time: times.get(version.id) ?? 0,
          index,
        }));
        for (const item of checkpoints)
          rows.push({
            version: {
              id: hostedId(target.room, item.id),
              projectId,
              name: `Hosted checkpoint ${new Date(item.createdAt).toLocaleString()}`,
            },
            time: item.createdAt,
            index: rows.length,
          });
        rows.sort((a, b) => a.time - b.time || a.index - b.index);
        return rows.map((row) => row.version);
      } catch {
        try {
          onUnavailable?.();
        } catch {
          /* best effort notice */
        }
        return versions;
      }
    },
    async getVersionTree(versionId) {
      const target = hostedStorageEnabled() ? getTarget() : undefined;
      const id = target ? parseId(versionId, target) : undefined;
      if (!target || !id) return local.getVersionTree(versionId);
      const project = await load(target, id, request);
      try {
        return tree(project);
      } finally {
        project.doc.destroy();
      }
    },
  };
}
/** Returns false for an ordinary local version. Call only from the human Restore action. */
export async function restoreHostedHistoryVersion(
  project: CollabProject,
  versionId: string,
  target: HostedHistoryTarget | undefined,
  author: Author,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (!hostedStorageEnabled() || !target || !versionId.startsWith("hosted:"))
    return false;
  const id = parseId(versionId, target);
  if (!id) throw new Error("Hosted checkpoint belongs to another room");
  const saved = await load(target, id, request);
  try {
    const files = tree(saved);
    const binaries = (saved.snapshot().binaryFiles ?? []).filter(
      (f) => !f.deleted,
    );
    const paths = new Set(
      saved
        .snapshot()
        .files.filter((f) => !f.deleted)
        .map((f) => f.path),
    );
    for (const f of binaries) {
      if (
        !isSafeProjectPath(f.path) ||
        !isValidHash(f.hash) ||
        !isValidMime(f.mime) ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0 ||
        f.size > BLOB_MAX_TRANSFER_BYTES ||
        paths.has(f.path)
      )
        throw new Error("Unsafe hosted binary checkpoint");
      paths.add(f.path);
    }
    // All validation happens before the first live write. Never apply old Yjs items into live state.
    restoreProjectFromTree(project, files, author);
    const current = project.snapshot().binaryFiles ?? [];
    const keep = new Set<string>();
    for (const f of binaries) {
      const existing = current.find(
        (c) =>
          c.path === f.path &&
          c.hash === f.hash &&
          c.size === f.size &&
          c.mime === f.mime,
      );
      if (existing) {
        project.restoreBinary(existing.fileId, author);
        keep.add(existing.fileId);
      } else
        keep.add(
          project.createBinary(
            f.path,
            { type: "binary", hash: f.hash, size: f.size, mime: f.mime },
            author,
          ),
        );
    }
    for (const f of current)
      if (!f.deleted && !keep.has(f.fileId))
        project.deleteBinary(f.fileId, author);
    return true;
  } finally {
    saved.doc.destroy();
  }
}
