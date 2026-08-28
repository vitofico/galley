import { describe, it, expect } from "vitest";
import type { FileProposalOp, ProjectSnapshot } from "@galley/collab";
import {
  planFileProposalAccept,
  verifyBinaryBlobsPresent,
  blobHashIsReferenced,
} from "./file-proposal-accept.js";

function snap(
  files: { fileId: string; path: string; text: string; deleted?: boolean }[],
  binaryFiles?: { fileId: string; path: string; deleted?: boolean; hash?: string }[],
): ProjectSnapshot {
  return {
    files: files.map((f) => ({ ...f, deleted: f.deleted ?? false })),
    mainFileId: files[0]?.fileId ?? null,
    duplicatePaths: [],
    ...(binaryFiles
      ? {
          binaryFiles: binaryFiles.map((f) => ({
            fileId: f.fileId,
            path: f.path,
            hash: f.hash ?? "h",
            size: 1,
            mime: "image/png",
            deleted: f.deleted ?? false,
          })),
        }
      : {}),
  };
}

const createIntro: FileProposalOp = {
  kind: "create",
  path: "/chapters/intro.typ",
  baseText: "",
  proposedText: "= Intro\n",
  blocks: [],
};
const editMain: FileProposalOp = {
  kind: "edit",
  path: "/main.typ",
  baseText: "= Title\nbody\n",
  proposedText: '= Title\nbody\n#include "chapters/intro.typ"\n',
  blocks: [{ search: "body\n", replace: 'body\n#include "chapters/intro.typ"\n' }],
};

describe("planFileProposalAccept — validate ALL ops before any mutation", () => {
  const base = snap([{ fileId: "m", path: "/main.typ", text: "= Title\nbody\n" }]);

  it("plans a create + edit change set when every op applies", () => {
    const result = planFileProposalAccept(base, [createIntro, editMain]);
    expect(result).toEqual({
      ok: true,
      plan: {
        creates: [{ path: "/chapters/intro.typ", text: "= Intro\n" }],
        edits: [{ fileId: "m", source: '= Title\nbody\n#include "chapters/intro.typ"\n' }],
        renames: [],
        deletes: [],
        binaryCreates: [],
      },
    });
  });

  it("rejects (no plan) when a create path already exists as a text file", () => {
    const s = snap([
      { fileId: "m", path: "/main.typ", text: "x\n" },
      { fileId: "i", path: "/chapters/intro.typ", text: "old\n" },
    ]);
    const result = planFileProposalAccept(s, [createIntro, editMain]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already exists/);
  });

  it("rejects when a create path collides with a live BINARY file", () => {
    const s = snap(
      [{ fileId: "m", path: "/main.typ", text: "x\n" }],
      [{ fileId: "b", path: "/chapters/intro.typ" }],
    );
    const result = planFileProposalAccept(s, [createIntro]);
    expect(result.ok).toBe(false);
  });

  it("rejects when an edit target is missing", () => {
    const result = planFileProposalAccept(snap([{ fileId: "x", path: "/other.typ", text: "x\n" }]), [
      editMain,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no longer/);
  });

  it("rejects when an edit target path collides with a live binary file", () => {
    const s = snap(
      [{ fileId: "m", path: "/main.typ", text: "= Title\nbody\n" }],
      [{ fileId: "b", path: "/main.typ" }],
    );
    const result = planFileProposalAccept(s, [editMain]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/share the path/);
  });

  it("rejects when an edit target has duplicate live paths", () => {
    const s = snap([
      { fileId: "m1", path: "/main.typ", text: "= Title\nbody\n" },
      { fileId: "m2", path: "/main.typ", text: "= Title\nbody\n" },
    ]);
    const result = planFileProposalAccept(s, [editMain]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/share the path/);
  });

  it("rejects (conflict, no plan) when the edit's blocks no longer match the live text", () => {
    const moved = snap([{ fileId: "m", path: "/main.typ", text: "= Title\nTOTALLY DIFFERENT\n" }]);
    const result = planFileProposalAccept(moved, [editMain]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no longer match/);
  });

  it("a single failing op poisons the WHOLE set (no partial plan)", () => {
    // create is fine, but the edit target is missing → the create must NOT be planned.
    const result = planFileProposalAccept(snap([{ fileId: "z", path: "/z.typ", text: "z\n" }]), [
      createIntro,
      editMain,
    ]);
    expect(result.ok).toBe(false);
  });

  it("conflict-resolves an edit when the live text moved but blocks still match uniquely", () => {
    // The user typed a NEW line elsewhere; the edit block still matches once.
    const moved = snap([{ fileId: "m", path: "/main.typ", text: "= Title\nbody\nuser line\n" }]);
    const result = planFileProposalAccept(moved, [editMain]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.edits[0]!.source).toBe(
        '= Title\nbody\n#include "chapters/intro.typ"\nuser line\n',
      );
    }
  });
});

describe("planFileProposalAccept — rename + delete (resolve path → live fileId)", () => {
  const base = snap([
    { fileId: "m", path: "/main.typ", text: "= Title\nbody\n" },
    { fileId: "o", path: "/old.typ", text: "old\n" },
  ]);
  const renameOld: FileProposalOp = {
    kind: "rename",
    path: "/old.typ",
    newPath: "/new.typ",
    baseText: "",
    proposedText: "",
    blocks: [],
  };
  const deleteOld: FileProposalOp = {
    kind: "delete",
    path: "/old.typ",
    baseText: "",
    proposedText: "",
    blocks: [],
  };

  it("plans a delete by resolving the path to its live fileId", () => {
    expect(planFileProposalAccept(base, [deleteOld])).toEqual({
      ok: true,
      plan: { creates: [], edits: [], renames: [], deletes: [{ fileId: "o" }], binaryCreates: [] },
    });
  });

  it("plans a rename to a free destination", () => {
    expect(planFileProposalAccept(base, [renameOld])).toEqual({
      ok: true,
      plan: { creates: [], edits: [], renames: [{ fileId: "o", newPath: "/new.typ" }], deletes: [], binaryCreates: [] },
    });
  });

  it("rejects a rename whose destination is occupied by a live text file", () => {
    const result = planFileProposalAccept(base, [{ ...renameOld, newPath: "/main.typ" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already exists|occupied/i);
  });

  it("rejects a rename whose destination is occupied by a live binary file", () => {
    const s = snap([{ fileId: "o", path: "/old.typ", text: "old\n" }], [{ fileId: "b", path: "/new.typ" }]);
    expect(planFileProposalAccept(s, [renameOld]).ok).toBe(false);
  });

  it("rejects a delete or rename whose source is no longer in the project", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "x\n" }]);
    expect(planFileProposalAccept(s, [deleteOld]).ok).toBe(false);
    expect(planFileProposalAccept(s, [renameOld]).ok).toBe(false);
  });

  it("rejects a delete whose target path is ambiguous (duplicate live paths)", () => {
    const s = snap([
      { fileId: "o1", path: "/old.typ", text: "a\n" },
      { fileId: "o2", path: "/old.typ", text: "b\n" },
    ]);
    expect(planFileProposalAccept(s, [deleteOld]).ok).toBe(false);
  });
});

describe("planFileProposalAccept — B3 restore: empty-blocks edit = full-file replacement (C1)", () => {
  // A restore proposal's `edit` ops carry NO blocks. The planner must treat them
  // as wholesale replacements (apply the version's text when the live file is
  // unchanged), and surface a STALE conflict — never a silent no-op — when the
  // live file moved since the proposal.
  const restoreEdit: FileProposalOp = {
    kind: "edit",
    path: "/main.typ",
    baseText: "live body\n",
    proposedText: "restored body\n",
    blocks: [],
  };

  it("restores: applies the version's text when the live file is UNCHANGED since the proposal", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "live body\n" }]);
    expect(planFileProposalAccept(s, [restoreEdit])).toEqual({
      ok: true,
      plan: { creates: [], edits: [{ fileId: "m", source: "restored body\n" }], renames: [], deletes: [], binaryCreates: [] },
    });
  });

  it("STALE: a CONFLICT (not a silent no-op, not a partial apply) when the live file CHANGED", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "user edited this since\n" }]);
    const result = planFileProposalAccept(s, [restoreEdit]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/changed since the restore/);
  });

  it("a restore change set with one STALE edit plans NOTHING (all-or-nothing)", () => {
    // One clean create + one stale restore edit → the whole set is rejected.
    const s = snap([{ fileId: "m", path: "/main.typ", text: "moved on\n" }]);
    const create: FileProposalOp = {
      kind: "create",
      path: "/added.typ",
      baseText: "",
      proposedText: "added\n",
      blocks: [],
    };
    expect(planFileProposalAccept(s, [create, restoreEdit]).ok).toBe(false);
  });
});

// --- A2: create-binary ops in the plan + the blob-presence gate -------------
describe("planFileProposalAccept — create-binary ops (A2)", () => {
  const asset = { type: "binary" as const, hash: "a".repeat(64), size: 10, mime: "image/png" };
  const binOp: FileProposalOp = {
    kind: "create-binary",
    path: "/logo.png",
    baseText: "",
    proposedText: "",
    blocks: [],
    binaryAsset: asset,
  };

  it("a create-binary op on a FREE path produces a binaryCreate (no apply yet)", () => {
    const r = planFileProposalAccept(snap([{ fileId: "f1", path: "/main.typ", text: "x" }]), [binOp]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.binaryCreates).toEqual([{ path: "/logo.png", asset }]);
    expect(r.plan.creates).toEqual([]);
  });

  it("a create-binary path occupied by a TEXT file is refused", () => {
    const r = planFileProposalAccept(snap([{ fileId: "f1", path: "/logo.png", text: "x" }]), [binOp]);
    expect(r.ok).toBe(false);
  });

  it("a create-binary path occupied by a BINARY file is refused", () => {
    const r = planFileProposalAccept(
      snap([{ fileId: "f1", path: "/main.typ", text: "x" }], [{ fileId: "b1", path: "/logo.png" }]),
      [binOp],
    );
    expect(r.ok).toBe(false);
  });

  it("two ops racing the same binary path within one set are refused", () => {
    const r = planFileProposalAccept(snap([{ fileId: "f1", path: "/main.typ", text: "x" }]), [
      binOp,
      { ...binOp },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("verifyBinaryBlobsPresent — the dangling-pointer gate (A2)", () => {
  const a1 = { type: "binary" as const, hash: "a".repeat(64), size: 1, mime: "image/png" };
  const a2 = { type: "binary" as const, hash: "b".repeat(64), size: 1, mime: "image/png" };

  it("ok when EVERY blob is present", async () => {
    const store = { get: async (h: string) => (h === a1.hash || h === a2.hash ? new Uint8Array([1]) : undefined) };
    const r = await verifyBinaryBlobsPresent([{ path: "/a.png", asset: a1 }, { path: "/b.png", asset: a2 }], store);
    expect(r.ok).toBe(true);
  });

  it("fails with the missing path when ANY blob is absent (all-or-nothing)", async () => {
    const store = { get: async (h: string) => (h === a1.hash ? new Uint8Array([1]) : undefined) };
    const r = await verifyBinaryBlobsPresent([{ path: "/a.png", asset: a1 }, { path: "/b.png", asset: a2 }], store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingPath).toBe("/b.png");
  });

  it("a corrupt blob (verify-on-read returns undefined) is treated as missing", async () => {
    const store = { get: async () => undefined }; // PersistentBlobStore.get returns undefined on hash-mismatch
    const r = await verifyBinaryBlobsPresent([{ path: "/a.png", asset: a1 }], store);
    expect(r.ok).toBe(false);
  });

  it("an empty binaryCreates list is trivially ok (text-only path never touches the store)", async () => {
    let called = false;
    const store = { get: async () => { called = true; return undefined; } };
    const r = await verifyBinaryBlobsPresent([], store);
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
  });

  it("a blobStore.get() REJECTION is fail-closed (treated as missing, never escapes — B3)", async () => {
    const store = { get: async () => { throw new Error("idb error"); } };
    // Must NOT reject — it resolves to {ok:false} so the accept leaves the proposal
    // pending and the auto path can roll its tombstone back.
    const r = await verifyBinaryBlobsPresent([{ path: "/a.png", asset: a1 }], store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingPath).toBe("/a.png");
  });
});

// ---------------------------------------------------------------------------
// blobHashIsReferenced — the C1 release-orphan delete guard (refcount-by-snapshot).
// A blob is safe to delete ONLY when NO binaryFiles entry — LIVE or soft-DELETED —
// references its hash (a tombstoned binary's bytes are retained for restore).
// ---------------------------------------------------------------------------
describe("blobHashIsReferenced (A2/C1 release-orphan guard)", () => {
  it("a LIVE binary file referencing the hash blocks the delete (referenced)", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "x" }], [
      { fileId: "b1", path: "/logo.png", hash: "H1" },
    ]);
    expect(blobHashIsReferenced(s, "H1")).toBe(true);
  });

  it("a SOFT-DELETED (tombstoned) binary file referencing the hash STILL blocks the delete (recoverability)", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "x" }], [
      { fileId: "b1", path: "/logo.png", hash: "H1", deleted: true },
    ]);
    // The tombstone's bytes are retained for restoreBinary — must NOT be deletable.
    expect(blobHashIsReferenced(s, "H1")).toBe(true);
  });

  it("a hash referenced by NO binaryFiles entry (live or deleted) is unreferenced (the orphan case → deletable)", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "x" }], [
      { fileId: "b1", path: "/logo.png", hash: "OTHER" },
      { fileId: "b2", path: "/old.png", hash: "ALSO-OTHER", deleted: true },
    ]);
    expect(blobHashIsReferenced(s, "ORPHAN")).toBe(false);
  });

  it("content-addressed sharing: a second file (even deleted) on the same hash blocks the delete", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "x" }], [
      { fileId: "b1", path: "/a.png", hash: "SHARED", deleted: true },
      { fileId: "b2", path: "/b.png", hash: "SHARED" },
    ]);
    expect(blobHashIsReferenced(s, "SHARED")).toBe(true);
  });

  it("a project with NO binaryFiles never references any hash", () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: "x" }]);
    expect(blobHashIsReferenced(s, "anything")).toBe(false);
  });
});
