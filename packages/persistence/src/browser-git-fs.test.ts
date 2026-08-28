/**
 * ADR-0019 canaries — prove the hand-rolled in-memory git fs (`createMemoryGitFs`)
 * satisfies the isomorphic-git fs subset the projection plumbing exercises, by
 * running the SAME object-plumbing (`commitTreeOnto`/`readTreeAtRef` and a full
 * init→writeBlob/writeTree/writeCommit→listFiles/readBlob round-trip) against it
 * with NO `node:fs`. A second, LOUD test pins the fs-contract assumption: if a
 * future isomorphic-git upgrade reaches for an fs method we have not modelled,
 * `MemFsContractError` trips HERE (in the gate), not in a user's browser.
 */
import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { createMemoryGitFs, MemFsContractError } from "./browser-git-fs.js";
import {
  commitTreeOnto,
  commitTreeToRef,
  readTreeAtRef,
  DEFAULT_FETCH_LIMITS,
  type GitFs,
} from "./git-remote-core.js";

const tree = (...files: [string, string][]) => files.map(([path, text]) => ({ path, text }));
const FULL_REF = "refs/heads/main";

async function bareGitdir(): Promise<{ fs: GitFs; gitdir: string }> {
  const fs = createMemoryGitFs() as unknown as GitFs;
  const gitdir = "/repo.git";
  await git.init({ fs, gitdir, bare: true, defaultBranch: "main" });
  return { fs, gitdir };
}

describe("createMemoryGitFs — git object plumbing round-trip (no node:fs)", () => {
  it("commits a tree and reads it back, identical to the node:fs path", async () => {
    const { fs, gitdir } = await bareGitdir();

    const res = await commitTreeOnto(
      fs,
      gitdir,
      FULL_REF,
      [],
      tree(["main.typ", "= Title"], ["chapters/one.typ", "Chapter one"], [".galley/project.json", "{}"]),
      1_700_000_000,
    );
    expect(res.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(res.ref).toBe(FULL_REF);

    const candidate = await readTreeAtRef(fs, gitdir, FULL_REF, DEFAULT_FETCH_LIMITS);
    expect(candidate).toEqual(
      tree([".galley/project.json", "{}"], ["chapters/one.typ", "Chapter one"], ["main.typ", "= Title"]),
    );
  });

  it("a second commit parents onto the prior one (linear history) on the in-memory fs", async () => {
    const { fs, gitdir } = await bareGitdir();
    const v1 = await commitTreeToRef(fs, gitdir, FULL_REF, tree(["a.typ", "one"]), 1_700_000_000);
    const v2 = await commitTreeToRef(fs, gitdir, FULL_REF, tree(["a.typ", "two"]), 1_700_000_100);
    expect(v2.oid).not.toBe(v1.oid);
    const log = await git.log({ fs, gitdir, ref: FULL_REF });
    expect(log.map((e) => e.oid)).toEqual([v2.oid, v1.oid]);
  });

  it("readTreeAtRef returns null for an absent ref", async () => {
    const { fs, gitdir } = await bareGitdir();
    expect(await readTreeAtRef(fs, gitdir, FULL_REF, DEFAULT_FETCH_LIMITS)).toBeNull();
  });

  it("honors the fetch-candidate byte caps on the in-memory fs", async () => {
    const { fs, gitdir } = await bareGitdir();
    await commitTreeOnto(fs, gitdir, FULL_REF, [], tree(["big.typ", "x".repeat(64)]), 1);
    await expect(
      readTreeAtRef(fs, gitdir, FULL_REF, { maxFiles: 8, maxFileBytes: 16, maxTotalBytes: 256 }),
    ).rejects.toThrow(/per-file byte cap/);
  });
});

describe("in-memory fs — fs-contract pin (loud on isomorphic-git upgrade)", () => {
  it("exposes the modelled PromiseFsClient subset push/fetch actually use", async () => {
    const fs = createMemoryGitFs();
    for (const method of [
      "readFile",
      "writeFile",
      "unlink",
      "readdir",
      "mkdir",
      "rmdir",
      "stat",
      "lstat",
      "symlink",
      "readlink",
    ]) {
      expect(typeof (fs.promises as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("trips a LOUD MemFsContractError if isomorphic-git reaches a KNOWN-but-unmodelled fs method", () => {
    const fs = createMemoryGitFs();
    // `chmod` is a real PromiseFsClient method we deliberately do NOT model. If a
    // future isomorphic-git upgrade starts calling it, reading the name must fail
    // loudly HERE (the gate), never silently in a user's browser.
    expect(() => (fs.promises as unknown as Record<string, unknown>).chmod).toThrow(MemFsContractError);
  });

  it("does NOT throw on isomorphic-git's internal probes (e.g. _original_unwrapped_fs)", () => {
    const fs = createMemoryGitFs();
    // The double-wrap probe must read as undefined, not throw — that's what
    // isomorphic-git expects from a plain, un-wrapped fs.
    expect((fs.promises as unknown as Record<string, unknown>)._original_unwrapped_fs).toBeUndefined();
  });

  it("the full git plumbing init→writeBlob→writeTree→writeCommit→listFiles→readBlob runs on the in-memory fs", async () => {
    const fs = createMemoryGitFs() as unknown as GitFs;
    const gitdir = "/canary.git";
    await git.init({ fs, gitdir, bare: true, defaultBranch: "main" });
    const blob = await git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode("hi") });
    const treeOid = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: "100644", path: "f.txt", oid: blob, type: "blob" }],
    });
    const commit = await git.writeCommit({
      fs,
      gitdir,
      commit: {
        tree: treeOid,
        parent: [],
        author: { name: "x", email: "x@y", timestamp: 1, timezoneOffset: 0 },
        committer: { name: "x", email: "x@y", timestamp: 1, timezoneOffset: 0 },
        message: "m\n",
      },
    });
    await git.writeRef({ fs, gitdir, ref: "refs/heads/main", value: commit, force: true });
    expect(await git.listFiles({ fs, gitdir, ref: commit })).toEqual(["f.txt"]);
    const { blob: read } = await git.readBlob({ fs, gitdir, oid: commit, filepath: "f.txt" });
    expect(new TextDecoder().decode(read)).toBe("hi");
  });
});
