/**
 * Roadmap #4 slice 1: the CRDT → git projection core. `materializeProject` turns
 * a `CollabProject` snapshot (the live source of truth) into a one-way,
 * human-readable git working tree (`.typ` files + a `.galley/project.json`
 * manifest) — never the other way (git is a projection, the CRDT is authority).
 * Pure + deterministic + offline: it consumes a plain `ProjectSnapshot` and emits
 * plain files, no Yjs/git/IO. One test wires a real `CollabProject` for realism.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { CollabProject } from "./collab-project.js";
import {
  materializeProject,
  materializeProjectBinaries,
  projectInstructionsFromTree,
  PROJECT_MANIFEST_PATH,
  PROJECT_INSTRUCTIONS_PATH,
} from "./materialize.js";
import type { ProjectSnapshot, BinaryFileSnapshot } from "./collab-project.js";

const human = { kind: "human" as const, userId: "u1" };
const ids = (p: string) => {
  let n = 0;
  return () => `${p}${n++}`;
};

function snap(
  files: { fileId: string; path: string; text: string; deleted?: boolean }[],
  mainFileId: string | null,
  duplicatePaths: string[] = [],
): ProjectSnapshot {
  return { files: files.map((f) => ({ deleted: false, ...f })), mainFileId, duplicatePaths };
}

describe("materializeProject (CRDT → git projection)", () => {
  it("projects live files to a relative-path tree + a manifest", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "#import \"intro.typ\"\n= Title" },
        { fileId: "f1", path: "/intro.typ", text: "Intro body" },
      ],
      "f0",
    );
    const out = materializeProject(s);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const byPath = Object.fromEntries(out.result.files.map((f) => [f.path, f.text]));
    // Tree paths are relative (no leading slash) so they drop straight into a repo.
    expect(byPath["main.typ"]).toContain("= Title");
    expect(byPath["intro.typ"]).toBe("Intro body");
    expect(byPath[PROJECT_MANIFEST_PATH]).toBeTruthy();

    expect(out.result.manifest.main).toBe("/main.typ");
    expect(out.result.manifest.files).toEqual([
      { path: "/intro.typ", fileId: "f1" },
      { path: "/main.typ", fileId: "f0" },
    ]);
    expect(out.result.manifest.schema).toBe("galley.project/v1");
  });

  it("excludes deleted (tombstoned) files from both the tree and the manifest", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "keep" },
        { fileId: "f1", path: "/old.typ", text: "gone", deleted: true },
      ],
      "f0",
    );
    const out = materializeProject(s);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const paths = out.result.files.map((f) => f.path);
    expect(paths).toContain("main.typ");
    expect(paths).not.toContain("old.typ");
    expect(out.result.manifest.files.map((f) => f.path)).toEqual(["/main.typ"]);
  });

  it("fails (never clobbers) on a duplicate live path", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/dup.typ", text: "a" },
        { fileId: "f1", path: "/dup.typ", text: "b" },
      ],
      "f0",
      ["/dup.typ"],
    );
    const out = materializeProject(s);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("duplicate_path");
    expect(out.detail).toContain("/dup.typ");
  });

  it("also detects a duplicate path the snapshot didn't pre-flag (defense in depth)", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/dup.typ", text: "a" },
        { fileId: "f1", path: "/dup.typ", text: "b" },
      ],
      "f0",
      [], // snapshot forgot to flag it
    );
    expect(materializeProject(s).ok).toBe(false);
  });

  it("fails closed on a genuinely unsafe path (traversal / backslash) — never writes outside the tree", () => {
    // NB: `/.galley/*` is no longer "unsafe" here — it's a reserved namespace that
    // is FILTERED OUT before the safety gate (14-D); see the reserved-skip test.
    for (const bad of ["/../escape.typ", "/a/../../etc/passwd", "/a\\b.typ"]) {
      const out = materializeProject(snap([{ fileId: "f0", path: bad, text: "x" }], "f0"));
      expect(out.ok, bad).toBe(false);
      if (!out.ok) expect(out.reason).toBe("unsafe_path");
    }
  });

  it("allows a project with no main (manifest.main = null) — export preserves files", () => {
    const s = snap([{ fileId: "f0", path: "/notes.typ", text: "x" }], null);
    const out = materializeProject(s);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.manifest.main).toBeNull();
    expect(out.result.files.map((f) => f.path)).toContain("notes.typ");
  });

  it("nests directory paths in the tree", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "m" },
        { fileId: "f1", path: "/chapters/one.typ", text: "c" },
      ],
      "f0",
    );
    const out = materializeProject(s);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.files.map((f) => f.path)).toContain("chapters/one.typ");
  });

  it("emits a deterministic, pretty-printed manifest (stable order, no timestamps)", () => {
    const s = snap(
      [
        { fileId: "f1", path: "/b.typ", text: "b" },
        { fileId: "f0", path: "/a.typ", text: "a" },
      ],
      "f0",
    );
    const a = materializeProject(s);
    const b = materializeProject(s);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const ma = a.result.files.find((f) => f.path === PROJECT_MANIFEST_PATH)!.text;
    const mb = b.result.files.find((f) => f.path === PROJECT_MANIFEST_PATH)!.text;
    expect(ma).toBe(mb); // deterministic
    expect(ma).toContain("\n"); // pretty-printed
    expect(JSON.parse(ma).files.map((f: { path: string }) => f.path)).toEqual(["/a.typ", "/b.typ"]);
  });

  it("excludes the reserved .galley namespace (instructions) but still materializes ok (14-D)", () => {
    // A live `/.galley/instructions` config file must NOT fail the projection
    // closed (the export/version/unify/compare regression) — it is filtered out
    // of the tree + manifest, while the rest projects normally.
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "= Doc" },
        { fileId: "fi", path: "/.galley/instructions", text: "Write tersely.\n\n## Constraints\nmax-words: 800" },
      ],
      "f0",
    );
    const out = materializeProject(s);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const paths = out.result.files.map((f) => f.path);
    expect(paths).toContain("main.typ");
    expect(paths).toContain(PROJECT_MANIFEST_PATH); // manifest still written
    expect(paths).not.toContain(".galley/instructions"); // instructions excluded
    // The manifest lists only user files, not the reserved config.
    expect(out.result.manifest.files.map((f) => f.path)).toEqual(["/main.typ"]);
    expect(out.result.manifest.main).toBe("/main.typ");
  });

  it("still fails closed on a genuinely unsafe path even alongside a reserved file (14-D)", () => {
    const s = snap(
      [
        { fileId: "fi", path: "/.galley/instructions", text: "ok" },
        { fileId: "fbad", path: "/../escape.typ", text: "x" },
      ],
      null,
    );
    const out = materializeProject(s);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unsafe_path");
  });

  it("opts the instructions config INTO the tree with includeInstructions (export round-trip)", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "= Doc" },
        { fileId: "fi", path: "/.galley/instructions", text: "Write tersely." },
      ],
      "f0",
    );
    const out = materializeProject(s, { includeInstructions: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const byPath = Object.fromEntries(out.result.files.map((f) => [f.path, f.text]));
    expect(byPath[PROJECT_INSTRUCTIONS_PATH]).toBe("Write tersely.");
    // Still sorted by path (determinism contract).
    const names = out.result.files.map((f) => f.path);
    expect(names).toEqual([...names].slice().sort());
    // Config, not a document: the manifest's structure map does NOT list it.
    expect(out.result.manifest.files.map((f) => f.path)).toEqual(["/main.typ"]);
  });

  it("includeInstructions with NO live instructions adds nothing (and a tombstoned one stays out)", () => {
    const none = materializeProject(
      snap([{ fileId: "f0", path: "/main.typ", text: "x" }], "f0"),
      { includeInstructions: true },
    );
    expect(none.ok).toBe(true);
    if (none.ok) {
      expect(none.result.files.map((f) => f.path)).not.toContain(PROJECT_INSTRUCTIONS_PATH);
    }

    const tombstoned = materializeProject(
      snap(
        [
          { fileId: "f0", path: "/main.typ", text: "x" },
          { fileId: "fi", path: "/.galley/instructions", text: "old", deleted: true },
        ],
        "f0",
      ),
      { includeInstructions: true },
    );
    expect(tombstoned.ok).toBe(true);
    if (tombstoned.ok) {
      expect(tombstoned.result.files.map((f) => f.path)).not.toContain(PROJECT_INSTRUCTIONS_PATH);
    }
  });

  it("picks instructions deterministically across duplicate forms (canonical first, lowest fileId)", () => {
    // Not-yet-coalesced strays: two canonical-form files + one relative-form file.
    // The projection must pick ONE deterministically: canonical form wins over
    // relative, lowest fileId within a form — input order must not matter.
    const files = [
      { fileId: "z9", path: "/.galley/instructions", text: "canonical-late" },
      { fileId: "a1", path: "/.galley/instructions", text: "canonical-early" },
      { fileId: "a0", path: ".galley/instructions", text: "relative" },
    ];
    for (const order of [files, [...files].reverse()]) {
      const out = materializeProject(
        snap([{ fileId: "f0", path: "/main.typ", text: "x" }, ...order], "f0"),
        { includeInstructions: true },
      );
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      const instr = out.result.files.find((f) => f.path === PROJECT_INSTRUCTIONS_PATH);
      expect(instr?.text).toBe("canonical-early");
    }
  });

  it("default options still exclude instructions — version snapshots stay config-free", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "= Doc" },
        { fileId: "fi", path: "/.galley/instructions", text: "Write tersely." },
      ],
      "f0",
    );
    for (const out of [materializeProject(s), materializeProject(s, {})]) {
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.result.files.map((f) => f.path)).not.toContain(PROJECT_INSTRUCTIONS_PATH);
      }
    }
  });

  it("materializes a real CollabProject snapshot (integration)", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    const main = p.create("/main.typ", "= Doc", human);
    p.create("/lib.typ", "#let x = 1", human);
    p.setMain(main, human);
    const out = materializeProject(p.snapshot());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const paths = out.result.files.map((f) => f.path).sort();
    expect(paths).toEqual([PROJECT_MANIFEST_PATH, "lib.typ", "main.typ"].sort());
    expect(out.result.manifest.main).toBe("/main.typ");
  });
});

describe("materializeProjectBinaries (#7 7C-4 — binary export projection)", () => {
  const bin = (o: Partial<BinaryFileSnapshot> & { fileId: string; path: string; hash: string }): BinaryFileSnapshot => ({
    size: 4,
    mime: "image/png",
    deleted: false,
    ...o,
  });

  it("projects live binaries whose bytes resolve to relative-path {path, bytes}", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/main.typ", text: "= D" }], "f0"),
      binaryFiles: [bin({ fileId: "b0", path: "/figures/plot.png", hash: "h1" })],
    };
    const out = materializeProjectBinaries(s, new Map([["h1", bytes]]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.files).toEqual([{ path: "figures/plot.png", bytes }]);
    expect(out.omitted).toEqual([]);
  });

  it("OMITS (does not fail) a pointer whose bytes are unavailable, and reports it", () => {
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/main.typ", text: "= D" }], "f0"),
      binaryFiles: [
        bin({ fileId: "b0", path: "/a.png", hash: "have" }),
        bin({ fileId: "b1", path: "/b.png", hash: "missing" }),
      ],
    };
    const out = materializeProjectBinaries(s, new Map([["have", new Uint8Array([9])]]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.files.map((f) => f.path)).toEqual(["a.png"]);
    expect(out.omitted).toEqual(["/b.png"]);
  });

  it("skips deleted binaries", () => {
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/main.typ", text: "= D" }], "f0"),
      binaryFiles: [bin({ fileId: "b0", path: "/gone.png", hash: "h", deleted: true })],
    };
    const out = materializeProjectBinaries(s, new Map([["h", new Uint8Array([1])]]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.files).toEqual([]);
    expect(out.omitted).toEqual([]);
  });

  it("fails closed when a binary path collides with a live text path", () => {
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/clash.png", text: "x" }], "f0"),
      binaryFiles: [bin({ fileId: "b0", path: "/clash.png", hash: "h" })],
    };
    const out = materializeProjectBinaries(s, new Map([["h", new Uint8Array([1])]]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("duplicate_path");
    expect(out.detail).toBe("/clash.png");
  });

  it("fails closed when two binaries share a path", () => {
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/main.typ", text: "x" }], "f0"),
      binaryFiles: [
        bin({ fileId: "b0", path: "/dup.png", hash: "h0" }),
        bin({ fileId: "b1", path: "/dup.png", hash: "h1" }),
      ],
    };
    const out = materializeProjectBinaries(s, new Map([["h0", new Uint8Array([1])], ["h1", new Uint8Array([2])]]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("duplicate_path");
  });

  it("fails closed on an unsafe binary path (traversal / reserved namespace)", () => {
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/main.typ", text: "x" }], "f0"),
      binaryFiles: [bin({ fileId: "b0", path: "/../escape.png", hash: "h" })],
    };
    const out = materializeProjectBinaries(s, new Map([["h", new Uint8Array([1])]]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unsafe_path");
  });

  it("returns empty for a text-only project (no binaryFiles)", () => {
    const out = materializeProjectBinaries(snap([{ fileId: "f0", path: "/main.typ", text: "x" }], "f0"), new Map());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.files).toEqual([]);
    expect(out.omitted).toEqual([]);
  });
});

describe("projectInstructionsFromTree (import side of the round-trip)", () => {
  it("finds the relative form a materialized tree carries", () => {
    const text = projectInstructionsFromTree([
      { path: "main.typ", text: "= Doc" },
      { path: ".galley/instructions", text: "Write tersely." },
    ]);
    expect(text).toBe("Write tersely.");
  });

  it("accepts the canonical leading-slash form for defense in depth", () => {
    const text = projectInstructionsFromTree([
      { path: "/.galley/instructions", text: "Canonical." },
    ]);
    expect(text).toBe("Canonical.");
  });

  it("returns undefined for a tree without instructions (existing config must stay untouched)", () => {
    expect(
      projectInstructionsFromTree([
        { path: "main.typ", text: "= Doc" },
        { path: ".galley/project.json", text: "{}" },
      ]),
    ).toBeUndefined();
  });

  it("round-trips: an opted-in projection's tree yields the same instructions text", () => {
    const out = materializeProject(
      snap(
        [
          { fileId: "f0", path: "/main.typ", text: "= Doc" },
          { fileId: "fi", path: "/.galley/instructions", text: "Keep it short.\n\n## Constraints\nmax-words: 100" },
        ],
        "f0",
      ),
      { includeInstructions: true },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(projectInstructionsFromTree(out.result.files)).toBe(
      "Keep it short.\n\n## Constraints\nmax-words: 100",
    );
  });
});
