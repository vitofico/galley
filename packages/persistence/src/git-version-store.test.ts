/**
 * Roadmap #4 slice 3b: the git-backed VersionStore over a real repo in a temp dir.
 * Proves named versions accumulate as commits, a materialized tree (incl. nested
 * paths + the .galley manifest) round-trips exactly, deletions are reflected, and
 * the CRDT→git projection from `materializeProject` flows straight in.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import git from "isomorphic-git";
import { CollabProject, materializeProject } from "@galley/collab";
import { GitVersionStore } from "./index.js";

let root: string;
let clock: number;
const store = () => new GitVersionStore(root, () => clock);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "galley-git-"));
  clock = 1_700_000_000;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const tree = (...files: [string, string][]) => files.map(([path, text]) => ({ path, text }));

describe("GitVersionStore", () => {
  it("commits a named version and reads its tree back exactly (nested paths included)", async () => {
    const vs = store();
    const v = await vs.createVersion(
      "p1",
      { name: "v1", message: "first cut" },
      tree(["main.typ", "= Title"], ["chapters/one.typ", "Chapter one"], [".galley/project.json", "{}"]),
    );
    expect(v.projectId).toBe("p1");
    expect(v.name).toBe("v1");
    expect(v.id.startsWith("p1@")).toBe(true);

    const got = await vs.getVersionTree(v.id);
    expect(got).toEqual(
      tree([".galley/project.json", "{}"], ["chapters/one.typ", "Chapter one"], ["main.typ", "= Title"]),
    );
  });

  it("accumulates history (a new instance over the same root sees prior versions)", async () => {
    clock = 1_700_000_000;
    const v1 = await store().createVersion("p1", { name: "v1" }, tree(["a.typ", "one"]));
    clock = 1_700_000_100;
    const v2 = await store().createVersion("p1", { name: "v2", message: "edit" }, tree(["a.typ", "two"]));

    const versions = await store().listVersions("p1"); // fresh instance
    expect(versions.map((x) => x.name)).toEqual(["v2", "v1"]); // git log: newest first
    expect(versions.find((x) => x.name === "v2")?.message).toBe("edit");

    // Each version's tree is its own snapshot.
    expect((await store().getVersionTree(v1.id))?.[0]?.text).toBe("one");
    expect((await store().getVersionTree(v2.id))?.[0]?.text).toBe("two");
  });

  it("reflects deletions across versions (a file dropped from the tree is gone)", async () => {
    const vs = store();
    await vs.createVersion("p1", { name: "v1" }, tree(["keep.typ", "k"], ["drop.typ", "d"]));
    clock += 100;
    const v2 = await vs.createVersion("p1", { name: "v2" }, tree(["keep.typ", "k"]));
    const paths = (await vs.getVersionTree(v2.id))!.map((f) => f.path);
    expect(paths).toEqual(["keep.typ"]);
  });

  it("round-trips a versionId even when the projectId contains '@'", async () => {
    const vs = store();
    const v = await vs.createVersion("user@org/proj", { name: "v1" }, tree(["a.typ", "hi"]));
    expect(v.id.endsWith(`@${v.id.slice(v.id.lastIndexOf("@") + 1)}`)).toBe(true);
    expect((await vs.getVersionTree(v.id))?.[0]?.text).toBe("hi"); // split on LAST '@'
  });

  it("isolates projects and returns [] / null for unknowns", async () => {
    const vs = store();
    await vs.createVersion("p1", { name: "v1" }, tree(["a.typ", "x"]));
    expect(await vs.listVersions("p2")).toEqual([]);
    expect(await vs.getVersionTree("p2@deadbeef")).toBeNull();
    expect(await vs.getVersionTree("malformed")).toBeNull();
  });

  it("round-trips contributors through commit trailers; omits them when absent (#11)", async () => {
    clock = 1_700_000_000;
    // No contributors → no trailer, field absent on read (back-compat with old commits).
    const without = await store().createVersion("p1", { name: "v1" }, tree(["a.typ", "one"]));
    expect("contributors" in without).toBe(false);

    clock = 1_700_000_100;
    const withC = await store().createVersion(
      "p1",
      { name: "v2", message: "edit", contributors: ["Alice", "Bob"] },
      tree(["a.typ", "two"]),
    );
    expect(withC.contributors).toEqual(["Alice", "Bob"]);

    // A fresh instance reads them back from the real commit message trailers.
    const versions = await store().listVersions("p1");
    const v2 = versions.find((x) => x.name === "v2");
    expect(v2?.contributors).toEqual(["Alice", "Bob"]);
    expect(v2?.message).toBe("edit"); // message still parsed alongside the trailer block
    const v1 = versions.find((x) => x.name === "v1");
    expect("contributors" in (v1 as object)).toBe(false);
  });

  it("does not confuse a plain message body for contributor trailers (#11)", async () => {
    const vs = store();
    const v = await vs.createVersion(
      "p1",
      { name: "v1", message: "line one\nline two" },
      tree(["a.typ", "x"]),
    );
    const list = await vs.listVersions("p1");
    const got = list.find((x) => x.id === v.id);
    expect(got?.message).toBe("line one\nline two");
    expect("contributors" in (got as object)).toBe(false);
  });

  it("stamps the saver's real identity as the commit author when `author` is given (#12)", async () => {
    const vs = store();
    const v = await vs.createVersion(
      "p1",
      { name: "v1", author: { name: "Ada Lovelace", email: "ada@users.galley.local" } },
      tree(["a.typ", "x"]),
    );
    const dir = join(root, "git", "p1");
    const oid = v.id.slice(v.id.lastIndexOf("@") + 1);
    const log = await git.log({ fs, dir, ref: oid, depth: 1 });
    expect(log[0]?.commit.author.name).toBe("Ada Lovelace");
    expect(log[0]?.commit.author.email).toBe("ada@users.galley.local");
  });

  it("falls back to the galley/galley@localhost author when none is given (#12)", async () => {
    const vs = store();
    const v = await vs.createVersion("p1", { name: "v1" }, tree(["a.typ", "x"]));
    const dir = join(root, "git", "p1");
    const oid = v.id.slice(v.id.lastIndexOf("@") + 1);
    const log = await git.log({ fs, dir, ref: oid, depth: 1 });
    expect(log[0]?.commit.author.name).toBe("galley");
    expect(log[0]?.commit.author.email).toBe("galley@localhost");
  });

  it("emits one Co-authored-by trailer per non-primary contributor, never self-co-authoring (#12)", async () => {
    const vs = store();
    const v = await vs.createVersion(
      "p1",
      {
        name: "v1",
        author: { name: "Alice", email: "alice@users.galley.local" },
        contributors: ["Alice", "Bob Smith", "Carol Q."],
      },
      tree(["a.typ", "x"]),
    );
    const dir = join(root, "git", "p1");
    const oid = v.id.slice(v.id.lastIndexOf("@") + 1);
    const log = await git.log({ fs, dir, ref: oid, depth: 1 });
    const msg = log[0]?.commit.message ?? "";
    const coLines = msg.split("\n").filter((l) => l.startsWith("Co-authored-by: "));
    // Alice == primary author → no self-co-author; Bob + Carol slugified.
    expect(coLines).toEqual([
      "Co-authored-by: Bob Smith <bob-smith@users.galley.local>",
      "Co-authored-by: Carol Q. <carol-q@users.galley.local>",
    ]);
    // #11 Galley-Contributor trailers still present for ALL contributors.
    const contribLines = msg.split("\n").filter((l) => l.startsWith("Galley-Contributor: "));
    expect(contribLines).toEqual([
      "Galley-Contributor: Alice",
      "Galley-Contributor: Bob Smith",
      "Galley-Contributor: Carol Q.",
    ]);
  });

  it("round-trips contributors unchanged even with Co-authored-by trailers present (#11 unbroken by #12)", async () => {
    await store().createVersion(
      "p1",
      {
        name: "v1",
        author: { name: "Alice", email: "alice@users.galley.local" },
        contributors: ["Alice", "Bob"],
      },
      tree(["a.typ", "x"]),
    );
    const versions = await store().listVersions("p1"); // fresh instance
    const v1 = versions.find((x) => x.name === "v1");
    expect(v1?.contributors).toEqual(["Alice", "Bob"]); // only Galley-Contributor lines are the source of truth
  });

  it("sanitizes CR/LF in author name/email and contributor labels (no broken commit) (#12)", async () => {
    const vs = store();
    const v = await vs.createVersion(
      "p1",
      {
        name: "v1",
        author: { name: "Eve\nInjected", email: "eve\r\n@x.local" },
        contributors: ["Eve\nInjected", "Mal\nlory"],
      },
      tree(["a.typ", "x"]),
    );
    const dir = join(root, "git", "p1");
    const oid = v.id.slice(v.id.lastIndexOf("@") + 1);
    const log = await git.log({ fs, dir, ref: oid, depth: 1 });
    // author identity has no embedded newline (would corrupt the commit object).
    expect(log[0]?.commit.author.name).not.toMatch(/[\r\n]/);
    expect(log[0]?.commit.author.email).not.toMatch(/[\r\n]/);
    const msg = log[0]?.commit.message ?? "";
    // Every trailer stays one line per entry.
    for (const l of msg.split("\n").filter((x) => x.startsWith("Galley-Contributor: ") || x.startsWith("Co-authored-by: "))) {
      expect(l).not.toMatch(/[\r\n]/);
    }
    // Round-trip still recovers the (sanitized) contributor labels.
    const v1 = (await store().listVersions("p1")).find((x) => x.name === "v1");
    expect(v1?.contributors).toEqual(["Eve Injected", "Mal lory"]);
  });

  it("projects a real CollabProject snapshot (materializeProject → git) and restores it", async () => {
    const p = new CollabProject(undefined, { newId: (() => { let n = 0; return () => `f${n++}`; })() });
    const main = p.create("/main.typ", "#import \"intro.typ\"\n= Doc", { kind: "human", userId: "alice" });
    p.create("/intro.typ", "Intro", { kind: "human", userId: "alice" });
    p.setMain(main, { kind: "human", userId: "alice" });

    const mat = materializeProject(p.snapshot());
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;

    const vs = store();
    const v = await vs.createVersion("proj", { name: "snapshot-1" }, mat.result.files);
    const restored = await vs.getVersionTree(v.id);
    const byPath = Object.fromEntries((restored ?? []).map((f) => [f.path, f.text]));
    expect(byPath["main.typ"]).toContain("= Doc");
    expect(byPath["intro.typ"]).toBe("Intro");
    expect(byPath[".galley/project.json"]).toContain("galley.project/v1");
  });
});
