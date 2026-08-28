/**
 * Lane S / ADR-0019 — a hand-rolled, in-memory git fs for the BROWSER transport.
 *
 * isomorphic-git's plumbing speaks to an injected `PromiseFsClient`. On Node that
 * is `node:fs`; in the browser we cannot import `node:fs` (it breaks the Vite
 * bundle), and we deliberately add NO external dependency (no `lightning-fs` — its
 * IndexedDB persistence is wrong for an ephemeral scratch repo; ADR-0019). So we
 * hand-roll the exact subset of the `PromiseFsClient` contract that push/fetch
 * exercise, backed by a `Map`. The scratch repo is per-op and ephemeral; the
 * browser adapter creates a fresh root for each operation and drops it after.
 *
 * ## The implemented subset (verified against isomorphic-git push/fetch)
 *   readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat, symlink,
 *   readlink, rm.
 * Errors carry a Node-style `.code` (`ENOENT`, `EEXIST`, `ENOTDIR`,
 * `ENOTEMPTY`) because isomorphic-git branches on `err.code` (e.g. ENOENT →
 * "absent", EEXIST → "already there"). A {@link MemFsContractError} is thrown for
 * any method/shape isomorphic-git might call that we have NOT modelled, so an
 * isomorphic-git upgrade that widens the contract fails LOUDLY in the gate's
 * canary rather than silently in a user's browser.
 */

const encoder = new TextEncoder();

/** A POSIX-ish errno error, the shape isomorphic-git branches on (`err.code`). */
export class FsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FsError";
  }
}

/**
 * Thrown when isomorphic-git calls part of the fs contract this in-memory adapter
 * does NOT implement. Loud-by-design: a future isomorphic-git upgrade that widens
 * its fs expectations trips this in the canary test, not in users' browsers.
 */
export class MemFsContractError extends Error {
  constructor(method: string) {
    super(
      `browser in-memory git fs: unsupported operation "${method}" — isomorphic-git's ` +
        `fs contract has widened beyond the modelled subset (pin/upgrade review needed).`,
    );
    this.name = "MemFsContractError";
  }
}

type NodeKind = "file" | "dir" | "symlink";

interface MemNode {
  kind: NodeKind;
  /** File contents (file only). */
  data?: Uint8Array;
  /** Symlink target (symlink only). */
  target?: string;
  mode: number;
  mtimeMs: number;
}

const DIR_MODE = 0o040000;
const FILE_MODE = 0o100644;
const SYMLINK_MODE = 0o120000;

/** A minimal `Stats` object — only the fields isomorphic-git reads. */
interface MemStats {
  type: NodeKind;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function statsOf(node: MemNode, size: number): MemStats {
  return {
    type: node.kind,
    mode: node.mode,
    size,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    ino: 1,
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "dir",
    isSymbolicLink: () => node.kind === "symlink",
  };
}

/** Normalize a path to a canonical absolute-ish form with no trailing slash. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function dirname(path: string): string {
  const n = normalize(path);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

function basename(path: string): string {
  const n = normalize(path);
  return n.slice(n.lastIndexOf("/") + 1);
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // isomorphic-git only ever writes strings or Uint8Array.
  throw new MemFsContractError("writeFile(non-string/Uint8Array data)");
}

/** The fs promises surface isomorphic-git uses, backed by an in-memory `Map`. */
class MemGitFsPromises {
  // Path → node. The root "/" always exists.
  private readonly nodes = new Map<string, MemNode>();

  constructor() {
    this.nodes.set("/", { kind: "dir", mode: DIR_MODE, mtimeMs: Date.now() });
  }

  private getNode(path: string): MemNode | undefined {
    return this.nodes.get(normalize(path));
  }

  private ensureParentDir(path: string): void {
    const parent = dirname(path);
    const node = this.nodes.get(parent);
    if (!node) throw new FsError("ENOENT", `ENOENT: no such directory, ${parent}`);
    if (node.kind !== "dir") throw new FsError("ENOTDIR", `ENOTDIR: not a directory, ${parent}`);
  }

  async readFile(path: string, options?: unknown): Promise<Uint8Array | string> {
    const node = this.getNode(path);
    if (!node) throw new FsError("ENOENT", `ENOENT: no such file, open '${normalize(path)}'`);
    if (node.kind === "dir") throw new FsError("EISDIR", `EISDIR: illegal operation on a directory, read`);
    const data = node.data ?? new Uint8Array(0);
    const encoding =
      typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
    if (encoding === "utf8" || encoding === "utf-8") return new TextDecoder().decode(data);
    return data;
  }

  async writeFile(path: string, data: unknown, options?: unknown): Promise<void> {
    this.ensureParentDir(path);
    const encoding =
      typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
    const bytes =
      typeof data === "string" && encoding && encoding !== "utf8" && encoding !== "utf-8"
        ? (() => {
            throw new MemFsContractError(`writeFile(encoding=${encoding})`);
          })()
        : toBytes(data);
    this.nodes.set(normalize(path), { kind: "file", data: bytes, mode: FILE_MODE, mtimeMs: Date.now() });
  }

  async unlink(path: string): Promise<void> {
    const node = this.getNode(path);
    if (!node) throw new FsError("ENOENT", `ENOENT: no such file, unlink '${normalize(path)}'`);
    if (node.kind === "dir") throw new FsError("EISDIR", `EISDIR: illegal operation on a directory, unlink`);
    this.nodes.delete(normalize(path));
  }

  async readdir(path: string, _options?: unknown): Promise<string[]> {
    const dir = normalize(path);
    const node = this.nodes.get(dir);
    if (!node) throw new FsError("ENOENT", `ENOENT: no such directory, scandir '${dir}'`);
    if (node.kind !== "dir") throw new FsError("ENOTDIR", `ENOTDIR: not a directory, scandir '${dir}'`);
    const prefix = dir === "/" ? "/" : dir + "/";
    const names = new Set<string>();
    for (const p of this.nodes.keys()) {
      if (p === dir || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split("/")[0];
      if (first) names.add(first);
    }
    return [...names].sort();
  }

  async mkdir(path: string, options?: unknown): Promise<void> {
    const dir = normalize(path);
    const recursive = !!(options as { recursive?: boolean } | undefined)?.recursive;
    if (this.nodes.has(dir)) {
      if (recursive) return;
      throw new FsError("EEXIST", `EEXIST: file already exists, mkdir '${dir}'`);
    }
    if (recursive) {
      // Create every missing ancestor.
      const segs = dir.slice(1).split("/").filter(Boolean);
      let cur = "";
      for (const seg of segs) {
        cur = cur + "/" + seg;
        if (!this.nodes.has(cur)) {
          this.nodes.set(cur, { kind: "dir", mode: DIR_MODE, mtimeMs: Date.now() });
        }
      }
      return;
    }
    this.ensureParentDir(path);
    this.nodes.set(dir, { kind: "dir", mode: DIR_MODE, mtimeMs: Date.now() });
  }

  async rmdir(path: string, _options?: unknown): Promise<void> {
    const dir = normalize(path);
    const node = this.nodes.get(dir);
    if (!node) throw new FsError("ENOENT", `ENOENT: no such directory, rmdir '${dir}'`);
    if (node.kind !== "dir") throw new FsError("ENOTDIR", `ENOTDIR: not a directory, rmdir '${dir}'`);
    if ((await this.readdir(dir)).length > 0) {
      throw new FsError("ENOTEMPTY", `ENOTEMPTY: directory not empty, rmdir '${dir}'`);
    }
    this.nodes.delete(dir);
  }

  /** Recursive delete (used only by the per-op scratch cleanup, not isomorphic-git). */
  async rm(path: string, options?: unknown): Promise<void> {
    const dir = normalize(path);
    const force = !!(options as { force?: boolean } | undefined)?.force;
    if (!this.nodes.has(dir)) {
      if (force) return;
      throw new FsError("ENOENT", `ENOENT: no such path, rm '${dir}'`);
    }
    const prefix = dir === "/" ? "/" : dir + "/";
    for (const p of [...this.nodes.keys()]) {
      if (p === dir || p.startsWith(prefix)) this.nodes.delete(p);
    }
  }

  async stat(path: string, _options?: unknown): Promise<MemStats> {
    // Resolve through a symlink (POSIX stat follows links).
    let node = this.getNode(path);
    let cur = normalize(path);
    let hops = 0;
    while (node && node.kind === "symlink") {
      if (++hops > 40) throw new FsError("ELOOP", `ELOOP: too many symbolic links, '${cur}'`);
      const target = node.target ?? "";
      cur = target.startsWith("/") ? normalize(target) : normalize(dirname(cur) + "/" + target);
      node = this.nodes.get(cur);
    }
    if (!node) throw new FsError("ENOENT", `ENOENT: no such file or directory, stat '${normalize(path)}'`);
    const size = node.kind === "file" ? (node.data?.byteLength ?? 0) : node.kind === "symlink" ? (node.target?.length ?? 0) : 0;
    return statsOf(node, size);
  }

  async lstat(path: string, _options?: unknown): Promise<MemStats> {
    const node = this.getNode(path);
    if (!node) throw new FsError("ENOENT", `ENOENT: no such file or directory, lstat '${normalize(path)}'`);
    const size = node.kind === "file" ? (node.data?.byteLength ?? 0) : node.kind === "symlink" ? (node.target?.length ?? 0) : 0;
    return statsOf(node, size);
  }

  async symlink(target: string, path: string): Promise<void> {
    this.ensureParentDir(path);
    this.nodes.set(normalize(path), { kind: "symlink", target, mode: SYMLINK_MODE, mtimeMs: Date.now() });
  }

  async readlink(path: string, _options?: unknown): Promise<string> {
    const node = this.getNode(path);
    if (!node) throw new FsError("ENOENT", `ENOENT: no such file, readlink '${normalize(path)}'`);
    if (node.kind !== "symlink") throw new FsError("EINVAL", `EINVAL: invalid argument, readlink`);
    return node.target ?? "";
  }
}

/** The `PromiseFsClient` shape isomorphic-git consumes: `{ promises: {...} }`. */
export interface MemoryGitFs {
  promises: MemGitFsPromises;
}

/** The `promises` method names this adapter models (the push/fetch subset). */
const MODELLED_METHODS = new Set([
  "readFile",
  "writeFile",
  "unlink",
  "readdir",
  "mkdir",
  "rmdir",
  "rm",
  "stat",
  "lstat",
  "symlink",
  "readlink",
]);

/**
 * The full set of `PromiseFsClient` fs methods isomorphic-git is known to be able
 * to call. Any of these NOT in {@link MODELLED_METHODS} is a contract widening we
 * have not implemented — reading its name trips a LOUD {@link MemFsContractError}
 * (in the gate's canary, never in a user's browser). Property reads OUTSIDE this
 * set (e.g. isomorphic-git's `_original_unwrapped_fs` double-wrap probe, or
 * `then` from promise-unwrapping) pass through untouched.
 */
const KNOWN_FS_METHODS = new Set([
  ...MODELLED_METHODS,
  "chmod",
  "copyFile",
  "rename",
  "truncate",
  "open",
  "close",
  "read",
  "write",
  "realpath",
  "access",
  "lchmod",
  "mkdtemp",
]);

/**
 * Construct a fresh in-memory git fs (its own isolated namespace). Returns the
 * `{ promises }` object isomorphic-git expects.
 *
 * The `promises` surface is wrapped in a Proxy that is the LOUD contract pin
 * (ADR-0019): reading a KNOWN fs method name we have NOT modelled trips
 * {@link MemFsContractError} — so a future isomorphic-git upgrade that reaches for
 * an unmodelled fs method fails in the gate's canary, not in users' browsers.
 * Everything else (modelled methods, and non-fs property reads like the
 * `_original_unwrapped_fs` double-wrap probe) passes through as on the plain
 * instance.
 */
export function createMemoryGitFs(): MemoryGitFs {
  const promises = new MemGitFsPromises();
  const guarded = new Proxy(promises, {
    get(target, prop, recv) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, recv);
      const name = String(prop);
      if (KNOWN_FS_METHODS.has(name) && !MODELLED_METHODS.has(name)) {
        throw new MemFsContractError(name);
      }
      const value = Reflect.get(target, prop, recv);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { promises: guarded as unknown as MemGitFsPromises };
}
