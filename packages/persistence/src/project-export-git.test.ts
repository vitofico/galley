/**
 * Roadmap #17.5 — export-as-git-repo core tests.
 *
 * The core (`exportProjectAsGitRepo`) is browser-safe (in-memory git fs, no
 * `node:*`), but these tests run on Node, so verification is allowed to be
 * Node-side and REAL: we parse the returned ustar with an independent inline
 * reader, extract it into a `mkdtemp` directory with `node:fs`, and read the
 * repo back with isomorphic-git over the REAL filesystem — proving the tar
 * contains a valid bare git repo whose HEAD commit tree matches the
 * materialized project byte-for-byte. Plus: determinism (two exports →
 * identical bytes), fail-closed outcomes, and an import-graph pin that keeps
 * the module browser-safe (no `node:*`, no Node-only git adapters).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile as readHostFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nodeFs from "node:fs";
import git from "isomorphic-git";
import { materializeProject, type ProjectSnapshot } from "@galley/collab";
import { exportProjectAsGitRepo } from "./project-export-git.js";

function snap(
  files: { fileId: string; path: string; text: string; deleted?: boolean }[],
  mainFileId: string | null,
  duplicatePaths: string[] = [],
): ProjectSnapshot {
  return { files: files.map((f) => ({ deleted: false, ...f })), mainFileId, duplicatePaths };
}

const PROJECT = snap(
  [
    { fileId: "f0", path: "/main.typ", text: '#import "chapters/one.typ"\n= Title\n' },
    { fileId: "f1", path: "/chapters/one.typ", text: "Chapter one — $x^2$\n" },
    { fileId: "f2", path: "/old.typ", text: "gone", deleted: true },
  ],
  "f0",
);

// --- Tiny inline ustar reader (test-only, independent of the writer) ---------
interface TarEntry {
  name: string;
  size: number;
  typeflag: string;
  magic: string;
  checksumOk: boolean;
  bytes: Uint8Array;
}

const dec = new TextDecoder();

function field(block: Uint8Array, off: number, len: number): string {
  const slice = block.subarray(off, off + len);
  let end = slice.indexOf(0);
  if (end === -1) end = slice.length;
  return dec.decode(slice.subarray(0, end)).replace(/[\s\0]+$/, "");
}

function verifyChecksum(block: Uint8Array): boolean {
  const stored = parseInt(field(block, 148, 8), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === stored;
}

function parseTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    const header = bytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero blocks
    const name = field(header, 0, 100);
    const size = parseInt(field(header, 124, 12), 8);
    const typeflag = String.fromCharCode(header[156]!);
    const magic = dec.decode(header.subarray(257, 262));
    const checksumOk = verifyChecksum(header);
    off += 512;
    const data = bytes.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    entries.push({ name, size, typeflag, magic, checksumOk, bytes: data });
  }
  return entries;
}

/** Extract the tar to a fresh temp dir using ONLY its own entries (dirs must be
 * present in the archive — we deliberately do not invent missing parents, so a
 * dropped directory entry fails the test). Returns the temp root. */
async function untarToTemp(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "galley-export-git-"));
  for (const e of parseTar(bytes)) {
    const target = join(root, e.name);
    if (e.typeflag === "5") await mkdir(target);
    else await writeFile(target, e.bytes);
  }
  return root;
}

async function exportAndExtract(snapshot: ProjectSnapshot, opts?: { timestampSec?: number }) {
  const out = await exportProjectAsGitRepo(snapshot, opts);
  if ("error" in out) throw new Error(`unexpected export error: ${out.error}`);
  const root = await untarToTemp(out.bytes);
  return { out, root, gitdir: join(root, "project.git") };
}

describe("exportProjectAsGitRepo — tar contains a real, clonable bare repo", () => {
  it("HEAD commit tree matches the materialized files byte-for-byte (real node:fs reads)", async () => {
    const { out, root, gitdir } = await exportAndExtract(PROJECT);
    try {
      expect(out.filename).toMatch(/\.tar$/);

      // HEAD resolves through refs/heads/main to the single export commit.
      const oid = await git.resolveRef({ fs: nodeFs, gitdir, ref: "HEAD" });
      expect(oid).toMatch(/^[0-9a-f]{40}$/);

      // Deterministic commit metadata: fixed identity, epoch-0 default, no parents.
      const { commit } = await git.readCommit({ fs: nodeFs, gitdir, oid });
      expect(commit.parent).toEqual([]);
      for (const who of [commit.author, commit.committer]) {
        expect(who.name).toBe("Galley");
        expect(who.email).toBe("galley@local");
        expect(who.timestamp).toBe(0);
        expect(who.timezoneOffset).toBe(0);
      }

      // The committed tree IS the materialized projection, byte-for-byte.
      const m = materializeProject(PROJECT);
      if (!m.ok) throw new Error("materialize failed");
      const expected = m.result.files; // sorted by path; includes .galley/project.json
      const paths = await git.listFiles({ fs: nodeFs, gitdir, ref: oid });
      expect([...paths].sort()).toEqual(expected.map((f) => f.path));
      for (const f of expected) {
        const { blob } = await git.readBlob({ fs: nodeFs, gitdir, oid, filepath: f.path });
        expect(Array.from(blob)).toEqual(Array.from(new TextEncoder().encode(f.text)));
      }
      // Deleted files are NOT in the export.
      expect(paths).not.toContain("old.typ");

      // It is a standard bare repo: HEAD points at the default branch.
      const head = await readHostFile(join(gitdir, "HEAD"), "utf8");
      expect(head).toBe("ref: refs/heads/main\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits binary blob bytes into the repo at their path (#7 7C-4)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const withBinary: ProjectSnapshot = {
      ...PROJECT,
      binaryFiles: [
        { fileId: "b0", path: "/figures/fig.png", hash: "hpng", size: png.length, mime: "image/png", deleted: false },
      ],
    };
    const out = await exportProjectAsGitRepo(withBinary, { blobsByHash: new Map([["hpng", png]]) });
    if ("error" in out) throw new Error(out.error);
    expect(out.omitted).toBeUndefined();
    const root = await untarToTemp(out.bytes);
    const gitdir = join(root, "project.git");
    try {
      const oid = await git.resolveRef({ fs: nodeFs, gitdir, ref: "HEAD" });
      const paths = await git.listFiles({ fs: nodeFs, gitdir, ref: oid });
      expect(paths).toContain("figures/fig.png");
      const { blob } = await git.readBlob({ fs: nodeFs, gitdir, oid, filepath: "figures/fig.png" });
      expect(Array.from(blob)).toEqual(Array.from(png));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits a binary whose bytes aren't supplied and reports it", async () => {
    const withBinary: ProjectSnapshot = {
      ...PROJECT,
      binaryFiles: [
        { fileId: "b0", path: "/figures/fig.png", hash: "absent", size: 3, mime: "image/png", deleted: false },
      ],
    };
    const out = await exportProjectAsGitRepo(withBinary);
    if ("error" in out) throw new Error(out.error);
    expect(out.omitted).toEqual(["/figures/fig.png"]);
    const root = await untarToTemp(out.bytes);
    const gitdir = join(root, "project.git");
    try {
      const oid = await git.resolveRef({ fs: nodeFs, gitdir, ref: "HEAD" });
      const paths = await git.listFiles({ fs: nodeFs, gitdir, ref: oid });
      expect(paths).not.toContain("figures/fig.png");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors an explicit timestampSec option (still deterministic per input)", async () => {
    const ts = 1_700_000_000;
    const { root, gitdir } = await exportAndExtract(PROJECT, { timestampSec: ts });
    try {
      const oid = await git.resolveRef({ fs: nodeFs, gitdir, ref: "HEAD" });
      const { commit } = await git.readCommit({ fs: nodeFs, gitdir, oid });
      expect(commit.author.timestamp).toBe(ts);
      expect(commit.committer.timestamp).toBe(ts);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives the bare-repo skeleton with explicit dir entries and valid ustar headers", async () => {
    const out = await exportProjectAsGitRepo(PROJECT);
    if ("error" in out) throw new Error(out.error);
    const entries = parseTar(out.bytes);
    for (const e of entries) {
      expect(e.checksumOk).toBe(true);
      expect(e.magic).toBe("ustar");
      expect(["0", "5"]).toContain(e.typeflag);
    }
    const dirs = entries.filter((e) => e.typeflag === "5").map((e) => e.name);
    // Empty skeleton dirs survive the tar (a bare repo needs refs/tags etc.).
    expect(dirs).toContain("project.git/");
    expect(dirs).toContain("project.git/refs/tags/");
    expect(dirs).toContain("project.git/objects/pack/");
    // Every entry lives under the single repo root.
    for (const e of entries) expect(e.name.startsWith("project.git/")).toBe(true);
    // Tar length is always a 512 multiple.
    expect(out.bytes.length % 512).toBe(0);
  });
});

describe("exportProjectAsGitRepo — determinism", () => {
  it("two exports of the same snapshot are byte-identical (no clocks anywhere)", async () => {
    const a = await exportProjectAsGitRepo(PROJECT);
    const b = await exportProjectAsGitRepo(PROJECT);
    if ("error" in a || "error" in b) throw new Error("unexpected error outcome");
    expect(a.bytes.length).toBe(b.bytes.length);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("an explicit timestamp changes the commit but stays run-to-run identical", async () => {
    const opts = { timestampSec: 1_700_000_000 };
    const a = await exportProjectAsGitRepo(PROJECT, opts);
    const b = await exportProjectAsGitRepo(PROJECT, opts);
    const epoch = await exportProjectAsGitRepo(PROJECT);
    if ("error" in a || "error" in b || "error" in epoch) throw new Error("unexpected error outcome");
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(epoch.bytes))).toBe(false);
  });
});

describe("exportProjectAsGitRepo — fail-closed outcomes (house style of bundleProject)", () => {
  it("fails closed when the project has no main file", async () => {
    const out = await exportProjectAsGitRepo(snap([{ fileId: "f0", path: "/x.typ", text: "x" }], null));
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error.toLowerCase()).toContain("main");
  });

  it("fails closed on a duplicate live path (materialize failure → error)", async () => {
    const out = await exportProjectAsGitRepo(
      snap(
        [
          { fileId: "f0", path: "/dup.typ", text: "one" },
          { fileId: "f1", path: "/dup.typ", text: "two" },
        ],
        "f0",
      ),
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("dup.typ");
  });

  it("fails closed on an unsafe path", async () => {
    const out = await exportProjectAsGitRepo(
      snap([{ fileId: "f0", path: "/../escape.typ", text: "x" }], "f0"),
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("unsafe_path");
  });
});

describe("exportProjectAsGitRepo — browser-safety import-graph pin (ADR-0019)", () => {
  it("the module imports no node:* and no Node-only git adapters", async () => {
    const src = await readHostFile(
      join(dirname(fileURLToPath(import.meta.url)), "project-export-git.ts"),
      "utf8",
    );
    const imports = Array.from(
      src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gms),
      (m) => m[1]!,
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec.startsWith("node:")).toBe(false);
      expect(spec).not.toContain("git-remote-node");
      // The whole library, not just /http: isomorphic-git's object-WRITE path
      // reaches for the Node `Buffer` global, which a Vite browser bundle does
      // not provide — the export must stay hand-rolled (Web Crypto + pako).
      expect(spec).not.toContain("isomorphic-git");
    }
  });

  it("is exported from the browser-safe barrel (@galley/persistence/browser)", async () => {
    const browser = await import("./browser.js");
    expect(typeof (browser as Record<string, unknown>).exportProjectAsGitRepo).toBe("function");
  });
});

describe("exportProjectAsGitRepo — .galley/instructions round-trip (14-D)", () => {
  it("the committed tree carries the project's instructions config at its real path", async () => {
    const project = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "= Title\n" },
        { fileId: "fi", path: "/.galley/instructions", text: "Write tersely.\n" },
      ],
      "f0",
    );
    const { root, gitdir } = await exportAndExtract(project);
    try {
      const oid = await git.resolveRef({ fs: nodeFs, gitdir, ref: "HEAD" });
      const paths = await git.listFiles({ fs: nodeFs, gitdir, ref: oid });
      expect(paths).toContain(".galley/instructions");
      const { blob } = await git.readBlob({
        fs: nodeFs,
        gitdir,
        oid,
        filepath: ".galley/instructions",
      });
      expect(new TextDecoder().decode(blob)).toBe("Write tersely.\n");
      // The tree equals the opted-in projection byte-for-byte (same contract as
      // the main byte-for-byte test, with the export's actual options).
      const m = materializeProject(project, { includeInstructions: true });
      if (!m.ok) throw new Error("materialize failed");
      expect([...paths].sort()).toEqual(m.result.files.map((f) => f.path));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a project without instructions exports no config entry (unchanged tree)", async () => {
    const { root, gitdir } = await exportAndExtract(PROJECT);
    try {
      const oid = await git.resolveRef({ fs: nodeFs, gitdir, ref: "HEAD" });
      const paths = await git.listFiles({ fs: nodeFs, gitdir, ref: oid });
      expect(paths).not.toContain(".galley/instructions");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("exportProjectAsGitRepo — canonical git tree-entry order", () => {
  it("a file sharing a prefix with a sibling directory sorts canonically ('notes.typ' before tree 'notes')", async () => {
    const project = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "= Title\n" },
        { fileId: "f1", path: "/notes.typ", text: "loose notes\n" },
        { fileId: "f2", path: "/notes/inner.typ", text: "inner\n" },
      ],
      "f0",
    );
    const { root, gitdir } = await exportAndExtract(project);
    try {
      const oid = await git.resolveRef({ fs: nodeFs, gitdir, ref: "HEAD" });
      // Canonical git order compares a directory as `name/`, so the FILE
      // "notes.typ" ('.' 0x2E) must precede the TREE "notes" ('/' 0x2F) in the
      // stored object. A plain name sort would invert the pair and the repo
      // would fail `git fsck` ("tree entry not sorted").
      //
      // The oracle reads the RAW loose object: isomorphic-git re-sorts tree
      // entries on BOTH write and parse (readTree can never observe the stored
      // byte order — this test originally used it and proved nothing), which is
      // exactly why the exporter hand-serializes its trees. Loose object =
      // zlib("tree <size>\0" + entries of `mode SP name NUL` + 20 oid bytes).
      const { commit } = await git.readCommit({ fs: nodeFs, gitdir, oid });
      const treeOid = commit.tree;
      const raw = inflateSync(
        await readHostFile(join(gitdir, "objects", treeOid.slice(0, 2), treeOid.slice(2))),
      );
      const names: string[] = [];
      let p = raw.indexOf(0) + 1; // skip the "tree <size>\0" header
      while (p < raw.length) {
        const sp = raw.indexOf(0x20, p);
        const nul = raw.indexOf(0, sp);
        names.push(raw.subarray(sp + 1, nul).toString("utf8"));
        p = nul + 1 + 20; // skip the 20 raw SHA-1 bytes
      }
      expect(names).toContain("notes.typ");
      expect(names).toContain("notes");
      expect(names.indexOf("notes.typ")).toBeLessThan(names.indexOf("notes"));
      // And both still read back intact.
      const paths = await git.listFiles({ fs: nodeFs, gitdir, ref: oid });
      expect(paths).toContain("notes.typ");
      expect(paths).toContain("notes/inner.typ");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
