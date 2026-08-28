import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import {
  CollabProject,
  CollabConnection,
  InMemoryNetwork,
  publishFileProposal,
  getFileProposals,
  getPendingFileProposals,
  getFileProposal,
  observeFileProposals,
  resolveFileProposal,
  fileProposalSizeViolation,
  FILE_PROPOSAL_LIMITS,
  type FileProposalInput,
  type FileProposalOp,
  type ProposalSigner,
} from "./index.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const MCP: Author = { kind: "agent", runId: "mcp" };

/** Two CollabProject peers joined through the in-memory hub (mirrors proposal-mailbox.test.ts). */
function twoPeers() {
  const net = new InMemoryNetwork();
  const a = new CollabProject();
  a.create("/main.typ", "= Title\nbody\n", HUMAN);
  const b = new CollabProject();
  const connA = new CollabConnection(a, net.endpoint());
  const connB = new CollabConnection(b, net.endpoint());
  connA.connect();
  connB.connect();
  return { a, b, connA, connB };
}

/** A create + edit change set: add /chapters/intro.typ and #include it from main. */
const INPUT: FileProposalInput = {
  request: "Add an intro chapter",
  ops: [
    {
      kind: "create",
      path: "/chapters/intro.typ",
      baseText: "",
      proposedText: "= Introduction\nHello.\n",
      blocks: [],
    },
    {
      kind: "edit",
      path: "/main.typ",
      baseText: "= Title\nbody\n",
      proposedText: '= Title\nbody\n#include "chapters/intro.typ"\n',
      blocks: [{ search: "body\n", replace: 'body\n#include "chapters/intro.typ"\n' }],
    },
  ],
};

describe("file-proposal mailbox — a shared multi-file pending-proposal record", () => {
  it("a file proposal published on one peer surfaces on the other", async () => {
    const { a, b, connA, connB } = twoPeers();

    const id = await publishFileProposal(b, INPUT, MCP);
    expect(typeof id).toBe("string");

    const pending = getPendingFileProposals(a);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id,
      request: "Add an intro chapter",
      author: "mcp",
      status: "pending",
      ops: [
        {
          kind: "create",
          path: "/chapters/intro.typ",
          baseText: "",
          proposedText: "= Introduction\nHello.\n",
          blocks: [],
        },
        {
          kind: "edit",
          path: "/main.typ",
          baseText: "= Title\nbody\n",
          proposedText: '= Title\nbody\n#include "chapters/intro.typ"\n',
          blocks: [{ search: "body\n", replace: 'body\n#include "chapters/intro.typ"\n' }],
        },
      ],
    });

    connA.destroy();
    connB.destroy();
  });

  it("publishing leaves every file's text byte-for-byte unchanged (the security pin)", async () => {
    const { a, b, connA, connB } = twoPeers();
    const beforeA = a.snapshot().files.map((f) => [f.path, f.text]);
    const beforeB = b.snapshot().files.map((f) => [f.path, f.text]);

    await publishFileProposal(b, INPUT, MCP);

    expect(a.snapshot().files.map((f) => [f.path, f.text])).toEqual(beforeA);
    expect(b.snapshot().files.map((f) => [f.path, f.text])).toEqual(beforeB);
    // No file was created either — publish writes ONLY the mailbox.
    expect(a.snapshot().files.some((f) => f.path === "/chapters/intro.typ")).toBe(false);

    connA.destroy();
    connB.destroy();
  });

  it("observeFileProposals fires when a proposal arrives AND when its status flips", async () => {
    const { a, b, connA, connB } = twoPeers();
    let fires = 0;
    const off = observeFileProposals(a, () => {
      fires += 1;
    });

    const id = await publishFileProposal(b, INPUT, MCP);
    expect(fires).toBeGreaterThanOrEqual(1);

    const seen = fires;
    resolveFileProposal(a, id, "accepted", HUMAN);
    expect(fires).toBeGreaterThan(seen);

    off();
    connA.destroy();
    connB.destroy();
  });

  it("resolveFileProposal records the verdict; unknown id throws (house style)", async () => {
    const { a, b, connA, connB } = twoPeers();
    const id = await publishFileProposal(b, INPUT, MCP);

    resolveFileProposal(b, id, "accepted", MCP);
    expect(getFileProposal(a, id)?.status).toBe("accepted");
    expect(getPendingFileProposals(a)).toHaveLength(0);

    expect(() => resolveFileProposal(b, "nope", "rejected", MCP)).toThrow(/unknown/);

    connA.destroy();
    connB.destroy();
  });

  it("getFileProposals lists oldest-first deterministically", async () => {
    const b = new CollabProject();
    const id1 = await publishFileProposal(b, { ...INPUT, request: "one" }, MCP);
    const id2 = await publishFileProposal(b, { ...INPUT, request: "two" }, MCP);
    const all = getFileProposals(b);
    expect(all.map((p) => p.id)).toEqual([id1, id2]);
  });
});

describe("fileProposalSizeViolation + readFileRecord double enforcement", () => {
  const okOp = INPUT.ops[0]!;

  it("accepts a within-bounds input", () => {
    expect(fileProposalSizeViolation(INPUT)).toBeNull();
  });

  it("rejects an over-long request", () => {
    const bad = { ...INPUT, request: "x".repeat(FILE_PROPOSAL_LIMITS.maxRequestChars + 1) };
    expect(fileProposalSizeViolation(bad)).toMatch(/request/);
  });

  it("rejects more than maxOps ops", () => {
    const ops = Array.from({ length: FILE_PROPOSAL_LIMITS.maxOps + 1 }, (_, i) => ({
      ...okOp,
      path: `/f${i}.typ`,
    }));
    expect(fileProposalSizeViolation({ request: "many", ops })).toMatch(/ops/);
  });

  it("rejects an op whose proposedText exceeds the per-op byte cap", () => {
    const big = "a".repeat(FILE_PROPOSAL_LIMITS.maxTextBytes + 1);
    const bad = { request: "big", ops: [{ ...okOp, proposedText: big }] };
    expect(fileProposalSizeViolation(bad)).toMatch(/bytes/);
  });

  it("rejects when the SUM of proposedText bytes exceeds the aggregate cap", () => {
    // Each op is under the per-op cap, but together they exceed maxTotalProposedBytes.
    const perOp = "a".repeat(FILE_PROPOSAL_LIMITS.maxTextBytes - 1);
    const count = Math.ceil(FILE_PROPOSAL_LIMITS.maxTotalProposedBytes / perOp.length) + 1;
    const ops = Array.from({ length: Math.min(count, FILE_PROPOSAL_LIMITS.maxOps) }, (_, i) => ({
      ...okOp,
      path: `/f${i}.typ`,
      proposedText: perOp,
    }));
    expect(fileProposalSizeViolation({ request: "agg", ops })).toMatch(/total/);
  });

  it("rejects an unsafe path (traversal / reserved namespace)", () => {
    expect(
      fileProposalSizeViolation({ request: "x", ops: [{ ...okOp, path: "/../escape.typ" }] }),
    ).toMatch(/path/);
    expect(
      fileProposalSizeViolation({ request: "x", ops: [{ ...okOp, path: "/.galley/x.typ" }] }),
    ).toMatch(/path/);
  });

  it("rejects two ops targeting the same path within one proposal", () => {
    const ops = [
      { ...okOp, path: "/dup.typ" },
      { ...okOp, path: "/dup.typ" },
    ];
    expect(fileProposalSizeViolation({ request: "dup", ops })).toMatch(/duplicate|same path/i);
  });

  it("publishFileProposal throws on a violating input", async () => {
    const b = new CollabProject();
    // Async publish: the size violation surfaces as a REJECTED promise.
    await expect(
      publishFileProposal(b, { ...INPUT, request: "x".repeat(10_000) }, MCP),
    ).rejects.toThrow();
  });

  it("readFileRecord skips a forged over-limit / unsafe record written straight into the map", () => {
    const b = new CollabProject();
    // Forge a record directly into the mailbox map, bypassing publishFileProposal.
    const map = b.doc.getMap<Y.Map<unknown>>("mcpFileProposals");
    const forged = new Y.Map<unknown>();
    b.doc.transact(() => {
      forged.set("id", "forged");
      forged.set("request", "forged");
      forged.set("author", "mcp");
      forged.set("status", "pending");
      forged.set("createdAt", 1);
      forged.set("seq", 0);
      // An op with an unsafe path — a hostile peer's forgery.
      forged.set("ops", [
        { kind: "create", path: "/../escape.typ", baseText: "", proposedText: "x", blocks: [] },
      ]);
      map.set("forged", forged);
    });
    // The forged record never surfaces — same posture as the single-file reader.
    expect(getFileProposals(b)).toHaveLength(0);
  });

  function forge(b: CollabProject, key: string, fields: Record<string, unknown>): void {
    const map = b.doc.getMap<Y.Map<unknown>>("mcpFileProposals");
    const rec = new Y.Map<unknown>();
    b.doc.transact(() => {
      for (const [k, v] of Object.entries(fields)) rec.set(k, v);
      map.set(key, rec);
    });
  }

  it("skips a forged record with a huge ops array (DoS: bounded before per-op work)", () => {
    const b = new CollabProject();
    const hugeOps = Array.from({ length: FILE_PROPOSAL_LIMITS.maxOps + 5000 }, (_, i) => ({
      kind: "create",
      path: `/f${i}.typ`,
      baseText: "",
      proposedText: "x",
      blocks: [],
    }));
    forge(b, "huge", {
      id: "huge",
      request: "x",
      author: "mcp",
      status: "pending",
      createdAt: 1,
      seq: 0,
      ops: hugeOps,
    });
    expect(getFileProposals(b)).toHaveLength(0);
  });

  it("rejects an oversized proposedText via the cheap length precheck (no giant encode)", () => {
    // A bounded ops/blocks array but a huge string — must be rejected by the
    // code-unit precheck before any TextEncoder allocation.
    const huge = "a".repeat(FILE_PROPOSAL_LIMITS.maxTextBytes + 1);
    expect(
      fileProposalSizeViolation({
        request: "x",
        ops: [{ kind: "create", path: "/big.typ", baseText: "", proposedText: huge, blocks: [] }],
      }),
    ).toMatch(/bytes/);
  });

  it("skips a forged record with an over-long path or id", () => {
    const b = new CollabProject();
    forge(b, "longpath", {
      id: "longpath",
      request: "x",
      author: "mcp",
      status: "pending",
      createdAt: 1,
      seq: 0,
      ops: [
        {
          kind: "create",
          path: "/" + "a".repeat(FILE_PROPOSAL_LIMITS.maxPathChars + 1),
          baseText: "",
          proposedText: "x",
          blocks: [],
        },
      ],
    });
    forge(b, "longid", {
      id: "i".repeat(FILE_PROPOSAL_LIMITS.maxIdChars + 1),
      request: "x",
      author: "mcp",
      status: "pending",
      createdAt: 1,
      seq: 0,
      ops: [{ kind: "create", path: "/ok.typ", baseText: "", proposedText: "x", blocks: [] }],
    });
    expect(getFileProposals(b)).toHaveLength(0);
  });
});

describe("rename + delete ops (file management)", () => {
  const renameOp: FileProposalOp = {
    kind: "rename",
    path: "/main.typ",
    newPath: "/paper.typ",
    baseText: "",
    proposedText: "",
    blocks: [],
  };
  const deleteOp: FileProposalOp = {
    kind: "delete",
    path: "/old.typ",
    baseText: "",
    proposedText: "",
    blocks: [],
  };

  it("accepts a within-bounds rename op and delete op", () => {
    expect(fileProposalSizeViolation({ request: "reorg", ops: [renameOp, deleteOp] })).toBeNull();
  });

  it("rejects a rename with an unsafe destination path", () => {
    expect(
      fileProposalSizeViolation({ request: "x", ops: [{ ...renameOp, newPath: "/../escape.typ" }] }),
    ).toMatch(/path/);
    expect(
      fileProposalSizeViolation({ request: "x", ops: [{ ...renameOp, newPath: "/.galley/x.typ" }] }),
    ).toMatch(/path/);
  });

  it("rejects a rename whose destination equals its source", () => {
    expect(
      fileProposalSizeViolation({ request: "x", ops: [{ ...renameOp, newPath: "/main.typ" }] }),
    ).toMatch(/same|destination|rename/i);
  });

  it("rejects when one op's destination collides with another op's path", () => {
    // rename /main.typ -> /paper.typ AND create /paper.typ : /paper.typ twice.
    const create: FileProposalOp = {
      kind: "create",
      path: "/paper.typ",
      baseText: "",
      proposedText: "x\n",
      blocks: [],
    };
    expect(
      fileProposalSizeViolation({ request: "x", ops: [renameOp, create] }),
    ).toMatch(/duplicate|same path/i);
  });

  it("round-trips a rename op's newPath through publish + read", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id = await publishFileProposal(b, { request: "rename main", ops: [renameOp] }, MCP);
    const rec = getFileProposal(b, id)!;
    expect(rec.ops[0]).toMatchObject({ kind: "rename", path: "/main.typ", newPath: "/paper.typ" });
  });

  it("skips a forged rename record with an unsafe destination", () => {
    const b = new CollabProject();
    const map = b.doc.getMap<Y.Map<unknown>>("mcpFileProposals");
    const forged = new Y.Map<unknown>();
    b.doc.transact(() => {
      forged.set("id", "forged");
      forged.set("request", "forged");
      forged.set("author", "mcp");
      forged.set("status", "pending");
      forged.set("createdAt", 1);
      forged.set("seq", 0);
      forged.set("ops", [
        { kind: "rename", path: "/main.typ", newPath: "/../escape.typ", baseText: "", proposedText: "", blocks: [] },
      ]);
      map.set("forged", forged);
    });
    expect(getFileProposals(b)).toHaveLength(0);
  });
});

// --- Provenance: sig + seq surface, map-key==id read guard (ADR-0023, Task 2) -

describe("file-proposal mailbox — provenance (sig, seq, map-key guard)", () => {
  // A trivial fake signer — we test only that `sig` round-trips, not crypto.
  const fakeSigner: ProposalSigner = async () => "AAAA";

  it("a record published WITH a signer carries `sig` and surfaces it on read", async () => {
    const b = new CollabProject();
    const id = await publishFileProposal(b, INPUT, MCP, fakeSigner);
    expect(getFileProposal(b, id)?.sig).toBe("AAAA");
    expect(getPendingFileProposals(b)[0]?.sig).toBe("AAAA");
  });

  it("publishing WITHOUT a signer leaves `sig` absent and still reads (back-compat)", async () => {
    const b = new CollabProject();
    const id = await publishFileProposal(b, INPUT, MCP);
    const rec = getFileProposal(b, id)!;
    expect(rec.sig).toBeUndefined();
    expect("sig" in rec).toBe(false); // exactOptionalPropertyTypes: omitted, not undefined
    expect(rec.request).toBe(INPUT.request);
  });

  it("promotes `seq` onto the public read record", async () => {
    const b = new CollabProject();
    const id = await publishFileProposal(b, INPUT, MCP);
    expect(typeof getFileProposal(b, id)?.seq).toBe("number");
    expect(typeof getFileProposals(b)[0]?.seq).toBe("number");
  });

  it("drops a record whose map KEY ≠ its signed `id` (record-swap guard)", async () => {
    const b = new CollabProject();
    const honest = await publishFileProposal(b, INPUT, MCP);

    // Forge a well-formed record whose own `id` disagrees with its map key.
    b.doc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("id", "real-id");
      forged.set("request", "swapped slot");
      forged.set("author", "mcp");
      forged.set("status", "pending");
      forged.set("createdAt", 0);
      forged.set("seq", 0);
      forged.set("ops", [
        { kind: "create", path: "/ok.typ", baseText: "", proposedText: "x\n", blocks: [] },
      ]);
      b.doc.getMap("mcpFileProposals").set("WRONG-KEY", forged as never);
    });

    expect(getFileProposals(b).map((p) => p.id)).toEqual([honest]);
    expect(getFileProposal(b, "WRONG-KEY")).toBeUndefined();
  });
});
