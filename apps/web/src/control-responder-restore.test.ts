import { describe, it, expect } from "vitest";
import type { ControlRequest } from "@galley/collab";
import { FILE_PROPOSAL_LIMITS, type FileProposalOp } from "@galley/collab";
import {
  computeRestoreDiff,
  answerRestoreVersionRequest,
  restoreVersionOps,
  type RestoreVersionSeams,
  type RestoreFile,
} from "./control-responder.js";

/**
 * B3 `request_restore_version` — the browser responder computes the diff
 * (live project → the target named version) as a multi-file FileProposalOp set
 * and PUBLISHES it as a NORMAL file proposal. The kernel NEVER writes files;
 * it only triggers this. These tests pin the PURE diff + the responder gate.
 */

function req(op: string, params: Record<string, unknown> = {}): ControlRequest {
  return { id: "id-restore-0001", op, params, createdAt: 1 };
}

/** Sort the way the diff emits (by path), so assertions are order-independent of input. */
function byPath(ops: FileProposalOp[]): FileProposalOp[] {
  return [...ops].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe("computeRestoreDiff — the pure live→target file diff (B3)", () => {
  it("emits a `create` for a target file absent from the live set", () => {
    const ops = computeRestoreDiff([], [{ path: "/new.typ", text: "fresh" }]);
    expect(ops).toEqual([
      { kind: "create", path: "/new.typ", baseText: "", proposedText: "fresh", blocks: [] },
    ]);
  });

  it("emits an `edit` for a target file whose text differs from live", () => {
    const ops = computeRestoreDiff(
      [{ path: "/main.typ", text: "old" }],
      [{ path: "/main.typ", text: "new" }],
    );
    expect(ops).toEqual([
      { kind: "edit", path: "/main.typ", baseText: "old", proposedText: "new", blocks: [] },
    ]);
  });

  it("emits NO op for a target file identical to live (no-op)", () => {
    const ops = computeRestoreDiff(
      [{ path: "/main.typ", text: "same" }],
      [{ path: "/main.typ", text: "same" }],
    );
    expect(ops).toEqual([]);
  });

  it("emits a `delete` for a live TEXT file absent from the target", () => {
    const ops = computeRestoreDiff(
      [
        { path: "/main.typ", text: "keep" },
        { path: "/gone.typ", text: "remove me" },
      ],
      [{ path: "/main.typ", text: "keep" }],
    );
    expect(ops).toEqual([
      { kind: "delete", path: "/gone.typ", baseText: "remove me", proposedText: "", blocks: [] },
    ]);
  });

  it("BINARY-DELETE SAFETY: the live set is TEXT-ONLY, so a binary file (never in the live set) is never deleted", () => {
    // The seam (projectLiveFileSet) returns TEXT files only. A binary asset like
    // /logo.png is therefore NEVER present in `current`, so the diff can never
    // emit a delete for it just because the text-only version tree lacks it.
    const live: RestoreFile[] = [{ path: "/main.typ", text: "doc" }];
    const target: RestoreFile[] = [{ path: "/main.typ", text: "doc" }];
    const ops = computeRestoreDiff(live, target);
    expect(ops).toEqual([]);
    // No op anywhere references the binary path.
    expect(ops.some((o) => o.path === "/logo.png")).toBe(false);
  });

  it("is deterministic: ops are sorted by path", () => {
    const ops = computeRestoreDiff(
      [{ path: "/z.typ", text: "z-old" }],
      [
        { path: "/z.typ", text: "z-new" },
        { path: "/a.typ", text: "a" },
        { path: "/m.typ", text: "m" },
      ],
    );
    expect(ops.map((o) => o.path)).toEqual(["/a.typ", "/m.typ", "/z.typ"]);
  });

  it("handles a mixed change set (create + edit + delete) together", () => {
    const ops = byPath(
      computeRestoreDiff(
        [
          { path: "/main.typ", text: "old-main" },
          { path: "/drop.typ", text: "dropme" },
          { path: "/same.typ", text: "unchanged" },
        ],
        [
          { path: "/main.typ", text: "new-main" },
          { path: "/same.typ", text: "unchanged" },
          { path: "/added.typ", text: "added" },
        ],
      ),
    );
    expect(ops).toEqual([
      { kind: "create", path: "/added.typ", baseText: "", proposedText: "added", blocks: [] },
      { kind: "delete", path: "/drop.typ", baseText: "dropme", proposedText: "", blocks: [] },
      { kind: "edit", path: "/main.typ", baseText: "old-main", proposedText: "new-main", blocks: [] },
    ]);
  });
});

describe("answerRestoreVersionRequest — the consent-gated responder gate (B3)", () => {
  const A_NAME = "Final draft";

  /** A seam baseline; individual tests override one field. */
  function seams(over: Partial<RestoreVersionSeams> = {}): RestoreVersionSeams {
    return {
      liveFileSet: async (projectId) =>
        projectId === "proj-1" ? [{ path: "/main.typ", text: "live" }] : null,
      versionTree: async (projectId, versionId) =>
        projectId === "proj-1" && versionId === "v1"
          ? [{ path: "/main.typ", text: "restored" }]
          : null,
      versionName: async (projectId, versionId) =>
        projectId === "proj-1" && versionId === "v1" ? A_NAME : null,
      publishRestore: async () => "prop-xyz",
      ...over,
    };
  }

  it("requires a projectId", async () => {
    const r = await answerRestoreVersionRequest(req("request_restore_version", {}), seams());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/projectId/);
  });

  it("requires a versionId", async () => {
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1" }),
      seams(),
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/versionId/);
  });

  // C2: the DOMAIN outcomes (not_open / unknown_version / too_large / no_changes
  // / conflict) are STRUCTURED ok:true statuses, NOT refusals — so they survive
  // the kernel's refusal-flattening (control.ts GENERIC_REFUSAL). Only genuine
  // param errors + seam throws stay ok:false. Consent stays a refusal (it is
  // gated in the MOUNT, never reaches this pure core).
  function statusOf(r: Awaited<ReturnType<typeof answerRestoreVersionRequest>>): string {
    expect(r.ok).toBe(true);
    return (r as { result: { status: string } }).result.status;
  }

  it("not_open status (ok:true) when no project is open (live set null)", async () => {
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({ liveFileSet: async () => null }),
    );
    expect(statusOf(r)).toBe("not_open");
  });

  it("unknown_version status (ok:true) when the version tree is null", async () => {
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "nope" }),
      seams({ versionTree: async () => null }),
    );
    expect(statusOf(r)).toBe("unknown_version");
  });

  it("unknown_version status (ok:true) when the version NAME is null", async () => {
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({ versionName: async () => null }),
    );
    expect(statusOf(r)).toBe("unknown_version");
  });

  it("no_changes status (and publishes NOTHING) when the project already equals the version", async () => {
    let published = 0;
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({
        liveFileSet: async () => [{ path: "/main.typ", text: "same" }],
        versionTree: async () => [{ path: "/main.typ", text: "same" }],
        publishRestore: async () => {
          published++;
          return "should-not-happen";
        },
      }),
    );
    expect(statusOf(r)).toBe("no_changes");
    expect(published).toBe(0);
  });

  it("too_large status (and publishes NOTHING) when the diff exceeds FILE_PROPOSAL_LIMITS", async () => {
    let published = 0;
    // maxOps + 1 distinct create ops → over the op cap, refused BEFORE publishing.
    const target: RestoreFile[] = Array.from(
      { length: FILE_PROPOSAL_LIMITS.maxOps + 1 },
      (_, i) => ({ path: `/f${i}.typ`, text: "x" }),
    );
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({
        liveFileSet: async () => [],
        versionTree: async () => target,
        publishRestore: async () => {
          published++;
          return "should-not-happen";
        },
      }),
    );
    expect(statusOf(r)).toBe("too_large");
    expect(published).toBe(0);
  });

  // C3: a duplicate path in the LIVE set (or the version tree) makes the
  // path→text Map collapse ambiguous, so the diff could come out falsely empty.
  // Detect it and return a `conflict` status — never no_changes, never publish.
  it("conflict status when the LIVE set has a duplicate path (no false no_changes), publishes NOTHING", async () => {
    let published = 0;
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({
        liveFileSet: async () => [
          { path: "/main.typ", text: "copy A" },
          { path: "/main.typ", text: "copy B" },
        ],
        versionTree: async () => [{ path: "/main.typ", text: "copy A" }],
        publishRestore: async () => {
          published++;
          return "should-not-happen";
        },
      }),
    );
    expect(statusOf(r)).toBe("conflict");
    expect(published).toBe(0);
  });

  it("conflict status when the VERSION tree has a duplicate path, publishes NOTHING", async () => {
    let published = 0;
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({
        liveFileSet: async () => [{ path: "/main.typ", text: "live" }],
        versionTree: async () => [
          { path: "/dup.typ", text: "one" },
          { path: "/dup.typ", text: "two" },
        ],
        publishRestore: async () => {
          published++;
          return "should-not-happen";
        },
      }),
    );
    expect(statusOf(r)).toBe("conflict");
    expect(published).toBe(0);
  });

  it("publishes the right ops + title and returns restore_proposed + proposalId on a real diff", async () => {
    let captured: { request: string; ops: FileProposalOp[] } | null = null;
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({
        liveFileSet: async () => [{ path: "/main.typ", text: "live" }],
        versionTree: async () => [{ path: "/main.typ", text: "restored" }],
        publishRestore: async (input) => {
          captured = input;
          return "prop-abc";
        },
      }),
    );
    expect(r.ok).toBe(true);
    const result = (r as { result: { status: string; proposalId: string } }).result;
    expect(result.status).toBe("restore_proposed");
    expect(result.proposalId).toBe("prop-abc");
    expect(captured).not.toBeNull();
    expect(captured!.request).toBe(`Restore to "${A_NAME}"`);
    expect(captured!.ops).toEqual([
      { kind: "edit", path: "/main.typ", baseText: "live", proposedText: "restored", blocks: [] },
    ]);
  });

  it("never throws — a seam throw becomes ok:false", async () => {
    const r = await answerRestoreVersionRequest(
      req("request_restore_version", { projectId: "proj-1", versionId: "v1" }),
      seams({
        liveFileSet: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("restoreVersionOps() names exactly the restore op", () => {
    expect(restoreVersionOps()).toEqual(["request_restore_version"]);
  });
});
