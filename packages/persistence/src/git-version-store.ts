/**
 * Git-backed `VersionStore` (roadmap #4 slice 3b, ADR-0018 §1/§2): named versions
 * materialized into a real git repo per project — "history-for-free", and the
 * project's data outlives the app (a plain repo any tool can read). The CRDT
 * stays the source of truth; this only *projects* snapshots (from
 * `materializeProject`) into commits — git is never read back as a merge input.
 *
 * Uses `isomorphic-git` (pure-JS, no native, no system `git`) over `node:fs`.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import fs from "node:fs";
import git from "isomorphic-git";
import type { Version, VersionedFile, VersionStore } from "@galley/shared";
import { KeyedMutex } from "./keyed-mutex.js";
// The commit-message format lives in its own browser-safe module: the web app's
// GitHub push path stamps the SAME trailers, and cannot import this Node-only file.
import { encodeMessage, decodeMessage, sanitizeTrailer } from "./version-message.js";

const AUTHOR = { name: "galley", email: "galley@localhost" } as const;
const ID_SEP = "@"; // versionId = `${projectId}@${commitOid}` (project ids are uuids/no '@')

/** The version-creation input shape (mirrors the `VersionStore` seam in @galley/shared). */
type CreateVersionInput = {
  name: string;
  message?: string;
  contributors?: string[];
  /** Roadmap #12: the saver's real identity, stamped as the git commit author. */
  author?: { name: string; email: string };
};

/** Seconds-resolution clock (git commit time). Injectable for deterministic tests. */
export type SecondsClock = () => number;

export class GitVersionStore implements VersionStore {
  private readonly lock = new KeyedMutex();
  constructor(
    private readonly root: string,
    private readonly nowSec: SecondsClock = () => Math.floor(Date.now() / 1000),
  ) {}

  private repoDir(projectId: string): string {
    return join(this.root, "git", projectId);
  }

  private async ensureRepo(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    if (!fs.existsSync(join(dir, ".git"))) {
      await git.init({ fs, dir, defaultBranch: "main" });
    }
  }

  createVersion(
    projectId: string,
    input: CreateVersionInput,
    tree: VersionedFile[],
  ): Promise<Version> {
    // Serialize per project: createVersion mutates the shared worktree + index;
    // concurrent calls would otherwise produce mixed trees / missed deletions.
    return this.lock.run(projectId, async () => {
      const dir = this.repoDir(projectId);
      await this.ensureRepo(dir);

      // Containment guard (defense in depth): every tree path must resolve inside
      // the repo — a `..` path must never write outside it. (materializeProject
      // already fails closed on unsafe paths; a tree from elsewhere is re-checked.)
      const rootAbs = resolve(dir);
      for (const f of tree) {
        const abs = resolve(dir, f.path);
        if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
          throw new Error(`unsafe version file path: ${f.path}`);
        }
      }

      // Reflect deletions: drop files tracked in HEAD that aren't in the new tree.
      const newPaths = new Set(tree.map((f) => f.path));
      let prev: string[] = [];
      try {
        prev = await git.listFiles({ fs, dir, ref: "HEAD" });
      } catch {
        prev = []; // no HEAD yet (first version)
      }
      for (const p of prev) {
        if (!newPaths.has(p)) {
          await rm(join(dir, p), { force: true });
          await git.remove({ fs, dir, filepath: p });
        }
      }

      // Write + stage the new tree.
      for (const f of tree) {
        const abs = join(dir, f.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.text);
        await git.add({ fs, dir, filepath: f.path });
      }

      // Stamp the saver's real identity (#12) when given, else the galley default.
      // Sanitize name/email so a CR/LF can't corrupt the commit object.
      const identity = input.author
        ? { name: sanitizeTrailer(input.author.name), email: sanitizeTrailer(input.author.email) }
        : { ...AUTHOR };
      const oid = await git.commit({
        fs,
        dir,
        message: encodeMessage(input),
        author: { ...identity, timestamp: this.nowSec(), timezoneOffset: 0 },
      });
      return makeVersion(projectId, oid, input);
    });
  }

  async listVersions(projectId: string): Promise<Version[]> {
    const dir = this.repoDir(projectId);
    let log: Awaited<ReturnType<typeof git.log>>;
    try {
      log = await git.log({ fs, dir });
    } catch {
      return []; // no repo / no commits yet
    }
    return log.map((entry) => {
      const { name, message, contributors } = decodeMessage(entry.commit.message);
      return makeVersion(projectId, entry.oid, {
        name,
        ...(message !== undefined ? { message } : {}),
        ...(contributors !== undefined ? { contributors } : {}),
      });
    });
  }

  async getVersionTree(versionId: string): Promise<VersionedFile[] | null> {
    // Split on the LAST separator: the oid (hex) never contains '@', so this
    // round-trips even a projectId that itself contains '@'.
    const at = versionId.lastIndexOf(ID_SEP);
    if (at < 0) return null;
    const projectId = versionId.slice(0, at);
    const oid = versionId.slice(at + 1);
    const dir = this.repoDir(projectId);
    try {
      const paths = await git.listFiles({ fs, dir, ref: oid });
      const out: VersionedFile[] = [];
      for (const path of paths) {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: path });
        out.push({ path, text: new TextDecoder().decode(blob) });
      }
      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return out;
    } catch {
      return null; // unknown commit / repo
    }
  }
}

function makeVersion(
  projectId: string,
  oid: string,
  input: { name: string; message?: string; contributors?: string[] },
): Version {
  // `author` (if present on the caller's input) is NOT part of the Version shape —
  // it lives only on the git commit object, so it is intentionally not read here.
  const id = `${projectId}${ID_SEP}${oid}`;
  return {
    id,
    projectId,
    name: input.name,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.contributors !== undefined && input.contributors.length > 0
      ? { contributors: input.contributors }
      : {}),
  };
}
