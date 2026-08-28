import { describe, it, expect } from "vitest";
import type { Author } from "@galley/shared";
import {
  CollabProject,
  publishProposal,
  publishFileProposal,
  getProposal,
  getFileProposal,
  getPendingProposals,
  resolveFileProposal,
  InMemoryBlobStore,
  sha256Hex,
  type BinaryAsset,
  type FileProposalInput,
} from "@galley/collab";
import { makeHeadlessApplySeam } from "./agent-apply-seam.js";
import type { FrozenApply } from "./agent-apply-core.js";

/**
 * Offline unit tests for the HEADLESS apply seam (F13.3) — the non-UI twin of
 * ProjectApp's onAcceptProposal/onAcceptFileProposal that the background host's
 * agent-apply-core invokes. They pin that it RE-PLANS against the live snapshot
 * (the verify→apply TOCTOU re-check) and lands the change as the agent peer.
 *
 * The seam receives a FROZEN payload (the decision core's output); these tests
 * publish a real proposal into a CollabProject, build a frozen view of it, and
 * drive the seam directly — no host, no relay, no decision core (that is pinned
 * separately in agent-apply-core.test).
 */

const HUMAN: Author = { kind: "human", userId: "u1" };
const MCP: Author = { kind: "agent", runId: "mcp" };

function project(): CollabProject {
  const p = new CollabProject();
  p.create("/main.typ", "body\n", HUMAN);
  return p;
}

/** A frozen single-file payload mirroring the published record (digest unused by the seam). */
function frozenSingle(record: ReturnType<typeof getProposal>): FrozenApply {
  return { kind: "single", record: record!, signable: {} as never, digest: "d" };
}

describe("agent-apply-seam — single-file re-plan against the live snapshot", () => {
  it("applies a clean proposal as the agent peer and records the verdict", async () => {
    const p = project();
    const id = await publishProposal(
      p,
      {
        filePath: "/main.typ",
        baseText: "body\n",
        proposedText: "body!\n",
        blocks: [{ search: "body\n", replace: "body!\n" }],
        request: "edit",
      },
      MCP,
    );
    const seam = makeHeadlessApplySeam(p, null);
    const ok = await seam(frozenSingle(getProposal(p, id)));
    expect(ok).toBe(true);
    // The live file now carries the agent edit, and the verdict is recorded.
    const file = p.snapshot().files.find((f) => f.path === "/main.typ");
    expect(file?.text).toBe("body!\n");
    expect(getProposal(p, id)?.status).toBe("accepted");
  });

  it("does NOT apply when the file changed since the proposal (TOCTOU conflict → pending)", async () => {
    const p = project();
    const id = await publishProposal(
      p,
      {
        filePath: "/main.typ",
        baseText: "body\n",
        proposedText: "body!\n",
        blocks: [{ search: "body\n", replace: "body!\n" }],
        request: "edit",
      },
      MCP,
    );
    // The file moves out from under the proposal AFTER it was published.
    const fileId = p.snapshot().files.find((f) => f.path === "/main.typ")!.fileId;
    p.transactFile(fileId, (t) => {
      t.delete(0, t.length);
      t.insert(0, "rewritten\n");
    }, HUMAN);
    const seam = makeHeadlessApplySeam(p, null);
    const ok = await seam(frozenSingle(getProposal(p, id)));
    expect(ok).toBe(false);
    // Nothing applied; the proposal stays pending for the human card.
    expect(p.snapshot().files.find((f) => f.path === "/main.typ")?.text).toBe("rewritten\n");
    expect(getProposal(p, id)?.status).toBe("pending");
  });

  it("does NOT apply when the target file is gone (missing → pending)", async () => {
    const p = project();
    const id = await publishProposal(
      p,
      {
        filePath: "/main.typ",
        baseText: "body\n",
        proposedText: "body!\n",
        blocks: [{ search: "body\n", replace: "body!\n" }],
        request: "edit",
      },
      MCP,
    );
    const fileId = p.snapshot().files.find((f) => f.path === "/main.typ")!.fileId;
    p.delete(fileId, HUMAN);
    const seam = makeHeadlessApplySeam(p, null);
    const ok = await seam(frozenSingle(getProposal(p, id)));
    expect(ok).toBe(false);
    expect(getProposal(p, id)?.status).toBe("pending");
  });

  it("a viewer (canMutate=false) never applies", async () => {
    const p = project();
    const id = await publishProposal(
      p,
      {
        filePath: "/main.typ",
        baseText: "body\n",
        proposedText: "body!\n",
        blocks: [{ search: "body\n", replace: "body!\n" }],
        request: "edit",
      },
      MCP,
    );
    const seam = makeHeadlessApplySeam(p, null, false);
    const ok = await seam(frozenSingle(getProposal(p, id)));
    expect(ok).toBe(false);
    expect(getProposal(p, id)?.status).toBe("pending");
    expect(getPendingProposals(p)).toHaveLength(1);
  });
});

describe("agent-apply-seam — multi-file all-or-nothing apply", () => {
  it("applies a clean multi-file create+edit atomically and records the verdict", async () => {
    const p = project();
    const input: FileProposalInput = {
      request: "scaffold",
      ops: [
        { kind: "create", path: "/new.typ", baseText: "", proposedText: "hi\n", blocks: [] },
        {
          kind: "edit",
          path: "/main.typ",
          baseText: "body\n",
          proposedText: "body!\n",
          blocks: [{ search: "body\n", replace: "body!\n" }],
        },
      ],
    };
    const id = await publishFileProposal(p, input, MCP);
    const seam = makeHeadlessApplySeam(p, null);
    const frozen: FrozenApply = {
      kind: "file",
      record: getFileProposal(p, id)!,
      signable: {} as never,
      digest: "d",
    };
    const ok = await seam(frozen);
    expect(ok).toBe(true);
    const files = p.snapshot().files;
    expect(files.find((f) => f.path === "/new.typ")?.text).toBe("hi\n");
    expect(files.find((f) => f.path === "/main.typ")?.text).toBe("body!\n");
    expect(getFileProposal(p, id)?.status).toBe("accepted");
  });
});

/**
 * Servable-provenance (Wave 14): a create-binary landed through a valid, operator-
 * armed AUTO-accept is a trusted local action, so its bytes become SERVABLE — but
 * ONLY once the Accept path has actually APPLIED the pointer. These tests pin that
 * the grant fires strictly AFTER the landing: not on proposal arrival, not at the
 * pre-Accept blob-presence check, and never for a conflicting/failed/viewer accept.
 * Each case would FAIL if `markServable` were moved before the pointer lands.
 */
function frozenFile(record: ReturnType<typeof getFileProposal>): FrozenApply {
  return { kind: "file", record: record!, signable: {} as never, digest: "d" };
}

/** Stage real bytes NEUTRALLY (put never grants) + publish a create-binary proposal for them. */
async function publishBinaryProposal(p: CollabProject, store: InMemoryBlobStore, path: string) {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const asset = await store.put(bytes); // NEUTRAL: put stores bytes but never marks servable
  const input: FileProposalInput = {
    request: "add image",
    ops: [
      { kind: "create-binary", path, baseText: "", proposedText: "", blocks: [], binaryAsset: asset },
    ],
  };
  const id = await publishFileProposal(p, input, MCP);
  return { id, asset };
}

describe("agent-apply-seam — servable-provenance grant (create-binary Accept)", () => {
  it("grants ONLY after the Accept lands the pointer — proposal arrival + bytes present is NOT enough", async () => {
    const p = project();
    const store = new InMemoryBlobStore();
    const { id, asset } = await publishBinaryProposal(p, store, "/logo.png");
    // The proposal has ARRIVED and the bytes are present, but nothing has been
    // Accepted — the bytes are a neutral cache. If the grant were at publish/put
    // time (before the landing) this would already be true.
    expect(await store.isServable(asset.hash)).toBe(false);

    const seam = makeHeadlessApplySeam(p, store);
    const ok = await seam(frozenFile(getFileProposal(p, id)));

    expect(ok).toBe(true);
    // The pointer LANDED in the doc …
    expect(
      p.snapshot().binaryFiles?.some((f) => f.path === "/logo.png" && f.hash === asset.hash),
    ).toBe(true);
    expect(getFileProposal(p, id)?.status).toBe("accepted");
    // … and ONLY now is the hash servable.
    expect(await store.isServable(asset.hash)).toBe(true);
  });

  it("a CONFLICTING create-binary (path already taken) leaves the present bytes NEUTRAL", async () => {
    const p = project();
    p.create("/logo.png", "not an image\n", HUMAN); // occupy the target path
    const store = new InMemoryBlobStore();
    const { id, asset } = await publishBinaryProposal(p, store, "/logo.png");

    const seam = makeHeadlessApplySeam(p, store);
    const ok = await seam(frozenFile(getFileProposal(p, id)));

    expect(ok).toBe(false);
    expect(getFileProposal(p, id)?.status).toBe("pending");
    // Rejected/conflicting → not servable, EVEN THOUGH the bytes are present. This
    // also proves the grant is NOT at the (passing) pre-Accept presence check.
    expect(await store.isServable(asset.hash)).toBe(false);
  });

  it("a create-binary whose bytes have NOT arrived is NOT granted (the pre-Accept presence gate never grants)", async () => {
    const p = project();
    const store = new InMemoryBlobStore();
    // A valid-shaped hash whose bytes were never put → the presence gate fails.
    const hash = await sha256Hex(new Uint8Array([9, 9, 9]));
    const asset: BinaryAsset = { type: "binary", hash, size: 3, mime: "image/png" };
    const id = await publishFileProposal(
      p,
      {
        request: "add image",
        ops: [
          { kind: "create-binary", path: "/logo.png", baseText: "", proposedText: "", blocks: [], binaryAsset: asset },
        ],
      },
      MCP,
    );

    const seam = makeHeadlessApplySeam(p, store);
    const ok = await seam(frozenFile(getFileProposal(p, id)));

    expect(ok).toBe(false); // bytes not present → nothing applied
    expect(getFileProposal(p, id)?.status).toBe("pending");
    expect(await store.isServable(asset.hash)).toBe(false);
  });

  it("a viewer (canMutate=false) never applies, so never grants", async () => {
    const p = project();
    const store = new InMemoryBlobStore();
    const { id, asset } = await publishBinaryProposal(p, store, "/logo.png");

    const seam = makeHeadlessApplySeam(p, store, false);
    const ok = await seam(frozenFile(getFileProposal(p, id)));

    expect(ok).toBe(false);
    expect(getFileProposal(p, id)?.status).toBe("pending");
    expect(await store.isServable(asset.hash)).toBe(false);
  });

  it("does NOT grant when the bytes ARE present but the pointer never lands (grant is after APPLY, not after the presence check)", async () => {
    const p = project();
    const store = new InMemoryBlobStore();
    const { id, asset } = await publishBinaryProposal(p, store, "/logo.png");
    // Resolve the proposal BEFORE the seam runs. The seam's pre-Accept presence
    // check will STILL PASS (the bytes are present), but the TOCTOU pending-gate
    // that follows makes applyFile land NOTHING. This is the case that separates a
    // grant placed at the (passing) presence check from one placed after the apply:
    // only the after-apply placement leaves this NEUTRAL.
    resolveFileProposal(p, id, "rejected", HUMAN);

    const seam = makeHeadlessApplySeam(p, store);
    const ok = await seam(frozenFile(getFileProposal(p, id)));

    expect(ok).toBe(false);
    expect(await store.isServable(asset.hash)).toBe(false);
  });
});
