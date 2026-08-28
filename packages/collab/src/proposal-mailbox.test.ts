import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import {
  CollabProject,
  CollabConnection,
  InMemoryNetwork,
  publishProposal,
  getProposals,
  getPendingProposals,
  getProposal,
  observeProposals,
  resolveProposal,
  PROPOSAL_LIMITS,
  publishFileProposal,
  getFileProposal,
  fileProposalSizeViolation,
  FILE_PROPOSAL_LIMITS,
  getPendingRunGroups,
  markRunOpen,
  markRunClosed,
  readRunOpen,
  RUN_ID_MAX_LEN,
  RUN_GROUP_MAX,
  RECORDS_PER_RUN_MAX,
  type ProposalSigner,
  type FileProposalInput,
} from "./index.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const MCP: Author = { kind: "agent", runId: "mcp" };

/** Two CollabProject peers joined through the in-memory hub (mirrors sync.test.ts). */
function twoPeers() {
  const net = new InMemoryNetwork();
  const a = new CollabProject();
  a.create("/main.typ", "= Title\nbody\n", HUMAN);
  a.create("/notes.typ", "some notes\n", HUMAN);
  const b = new CollabProject();
  const connA = new CollabConnection(a, net.endpoint());
  const connB = new CollabConnection(b, net.endpoint());
  connA.connect();
  connB.connect();
  return { a, b, connA, connB };
}

const PROPOSAL = {
  filePath: "/main.typ",
  baseText: "= Title\nbody\n",
  proposedText: "= Title\nbody\nmore\n",
  blocks: [{ search: "body\n", replace: "body\nmore\n" }],
  request: "Add a closing line",
};

describe("proposal mailbox — a shared pending-proposal record (ADR-0020)", () => {
  it("a proposal published on one peer surfaces on the other", async () => {
    const { a, b, connA, connB } = twoPeers();

    const id = await publishProposal(b, PROPOSAL, MCP);
    expect(typeof id).toBe("string");

    const pending = getPendingProposals(a);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id,
      filePath: "/main.typ",
      baseText: "= Title\nbody\n",
      proposedText: "= Title\nbody\nmore\n",
      blocks: [{ search: "body\n", replace: "body\nmore\n" }],
      request: "Add a closing line",
      author: "mcp",
      status: "pending",
    });

    connA.destroy();
    connB.destroy();
  });

  it("publishing leaves every file's text byte-for-byte unchanged (the security pin)", async () => {
    const { a, b, connA, connB } = twoPeers();
    const beforeA = a.snapshot().files.map((f) => [f.path, f.text]);
    const beforeB = b.snapshot().files.map((f) => [f.path, f.text]);

    await publishProposal(b, PROPOSAL, MCP);

    expect(a.snapshot().files.map((f) => [f.path, f.text])).toEqual(beforeA);
    expect(b.snapshot().files.map((f) => [f.path, f.text])).toEqual(beforeB);

    connA.destroy();
    connB.destroy();
  });

  it("observeProposals fires when a proposal arrives AND when its status flips", async () => {
    const { a, b, connA, connB } = twoPeers();
    let calls = 0;
    const unobserve = observeProposals(a, () => {
      calls += 1;
    });

    const id = await publishProposal(b, PROPOSAL, MCP);
    expect(calls).toBeGreaterThan(0);

    const afterPublish = calls;
    resolveProposal(b, id, "accepted", HUMAN);
    expect(calls).toBeGreaterThan(afterPublish);

    unobserve();
    const afterUnobserve = calls;
    await publishProposal(b, PROPOSAL, MCP);
    expect(calls).toBe(afterUnobserve);

    connA.destroy();
    connB.destroy();
  });

  it("resolveProposal flips status, propagates, and drops it from the pending list", async () => {
    const { a, b, connA, connB } = twoPeers();
    const id = await publishProposal(b, PROPOSAL, MCP);

    // The browser peer (A) resolves; the kernel peer (B) sees the verdict.
    resolveProposal(a, id, "rejected", HUMAN);
    expect(getPendingProposals(a)).toHaveLength(0);
    expect(getPendingProposals(b)).toHaveLength(0);
    expect(getProposal(b, id)?.status).toBe("rejected");

    connA.destroy();
    connB.destroy();
  });

  it("resolveProposal throws on an unknown id (never silently no-ops)", () => {
    const { a, connA, connB } = twoPeers();
    expect(() => resolveProposal(a, "nope", "accepted", HUMAN)).toThrow(/unknown proposal/);
    connA.destroy();
    connB.destroy();
  });

  it("mints unguessable (CSPRNG) ids — distinct across proposals", async () => {
    const { a, connA, connB } = twoPeers();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add(await publishProposal(a, PROPOSAL, MCP));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(32);
    connA.destroy();
    connB.destroy();
  });

  it("lists multiple pending proposals deterministically (oldest first) and skips malformed records", async () => {
    const { a, b, connA, connB } = twoPeers();
    const id1 = await publishProposal(a, { ...PROPOSAL, request: "first" }, MCP);
    const id2 = await publishProposal(a, { ...PROPOSAL, request: "second" }, MCP);

    // A hostile/buggy peer writes garbage into the mailbox map: readers skip it.
    a.doc.transact(() => {
      a.doc.getMap("mcpProposals").set("garbage", "not a record" as never);
    });

    const pending = getPendingProposals(b);
    expect(pending.map((p) => p.id)).toEqual([id1, id2]);
    expect(pending.map((p) => p.request)).toEqual(["first", "second"]);

    connA.destroy();
    connB.destroy();
  });

  // --- Size limits (Security-Analyst round, finding 1) -----------------------

  it("publishProposal throws on over-limit input — oversized records never enter the CRDT", async () => {
    const { a, connA, connB } = twoPeers();
    const big = "x".repeat(PROPOSAL_LIMITS.maxTextBytes + 1);

    // Async publish: the size violation surfaces as a REJECTED promise (the
    // throw happens before any await), so it never enters the CRDT.
    await expect(publishProposal(a, { ...PROPOSAL, proposedText: big }, MCP)).rejects.toThrow(
      /proposedText exceeds/,
    );
    await expect(publishProposal(a, { ...PROPOSAL, baseText: big }, MCP)).rejects.toThrow(
      /baseText exceeds/,
    );
    await expect(
      publishProposal(
        a,
        { ...PROPOSAL, blocks: Array(PROPOSAL_LIMITS.maxBlocks + 1).fill(PROPOSAL.blocks[0]) },
        MCP,
      ),
    ).rejects.toThrow(/edit blocks/);
    await expect(
      publishProposal(
        a,
        {
          ...PROPOSAL,
          blocks: [{ search: "y".repeat(PROPOSAL_LIMITS.maxBlockBytes + 1), replace: "z" }],
        },
        MCP,
      ),
    ).rejects.toThrow(/block exceeds/);
    await expect(
      publishProposal(
        a,
        { ...PROPOSAL, request: "r".repeat(PROPOSAL_LIMITS.maxRequestChars + 1) },
        MCP,
      ),
    ).rejects.toThrow(/request exceeds/);

    expect(getPendingProposals(a)).toHaveLength(0); // nothing leaked into the mailbox
    connA.destroy();
    connB.destroy();
  });

  it("a FORGED over-limit record written straight into the Y.Map is skipped by readers (no Accept affordance, no diff input)", async () => {
    const { a, b, connA, connB } = twoPeers();
    const ok = await publishProposal(a, PROPOSAL, MCP);

    // A hostile peer bypasses publishProposal and forges a huge record directly.
    a.doc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("id", "forged");
      forged.set("filePath", "/main.typ");
      forged.set("baseText", "= Title\nbody\n");
      forged.set("proposedText", "x".repeat(PROPOSAL_LIMITS.maxTextBytes + 1));
      forged.set("blocks", []);
      forged.set("request", "innocent looking");
      forged.set("author", "mcp");
      forged.set("status", "pending");
      forged.set("createdAt", 0);
      a.doc.getMap("mcpProposals").set("forged", forged as never);
    });

    // Both peers surface only the honest proposal; the forgery is invisible.
    expect(getPendingProposals(a).map((p) => p.id)).toEqual([ok]);
    expect(getPendingProposals(b).map((p) => p.id)).toEqual([ok]);
    expect(getProposal(b, "forged")).toBeUndefined();

    connA.destroy();
    connB.destroy();
  });

  it("a forged FRACTIONAL seq/createdAt is dropped (signed bytes truncate — Medium-2)", () => {
    const a = new CollabProject();
    const forged = new Y.Map<unknown>();
    forged.set("id", "frac");
    forged.set("filePath", "/main.typ");
    forged.set("baseText", "= Title\nbody\n");
    forged.set("proposedText", "= Title\nbody\nmore\n");
    forged.set("blocks", []);
    forged.set("request", "fractional seq");
    forged.set("author", "mcp");
    forged.set("status", "pending");
    forged.set("createdAt", 1000);
    forged.set("seq", 1.5); // a peer mutates seq within an integer bucket
    a.doc.getMap("mcpProposals").set("frac", forged as never);
    expect(getProposal(a, "frac")).toBeUndefined();
    expect(getPendingProposals(a)).toHaveLength(0);
  });

  it("a forged record with an over-cap MULTIBYTE baseText is rejected at read time (no attacker-sized encode)", () => {
    const a = new CollabProject();
    // A single multibyte char is 3 UTF-8 bytes; just over the cap in code units
    // already exceeds the byte cap — the cheap char-length short-circuit fires.
    const huge = "あ".repeat(PROPOSAL_LIMITS.maxTextBytes + 1);
    const forged = new Y.Map<unknown>();
    forged.set("id", "multibyte");
    forged.set("filePath", "/main.typ");
    forged.set("baseText", huge);
    forged.set("proposedText", "= Title\nbody\n");
    forged.set("blocks", []);
    forged.set("request", "multibyte baseText");
    forged.set("author", "mcp");
    forged.set("status", "pending");
    forged.set("createdAt", 0);
    forged.set("seq", 0);
    a.doc.getMap("mcpProposals").set("multibyte", forged as never);
    expect(getProposal(a, "multibyte")).toBeUndefined();
    expect(getPendingProposals(a)).toHaveLength(0);
  });

  it("a forged record with an oversized blocks array is rejected by the early-bail length cap", () => {
    const a = new CollabProject();
    const forged = new Y.Map<unknown>();
    forged.set("id", "manyblocks");
    forged.set("filePath", "/main.typ");
    forged.set("baseText", "= Title\nbody\n");
    forged.set("proposedText", "= Title\nbody\nmore\n");
    // More blocks than the cap — the readRecord length cap bails BEFORE the
    // per-element `.every(isEditBlock)` scan (mirrors readFileRecord).
    forged.set(
      "blocks",
      Array(PROPOSAL_LIMITS.maxBlocks + 1).fill({ search: "a", replace: "b" }),
    );
    forged.set("request", "many blocks");
    forged.set("author", "mcp");
    forged.set("status", "pending");
    forged.set("createdAt", 0);
    forged.set("seq", 0);
    a.doc.getMap("mcpProposals").set("manyblocks", forged as never);
    expect(getProposal(a, "manyblocks")).toBeUndefined();
    expect(getPendingProposals(a)).toHaveLength(0);
  });
});

// --- Provenance: sig + seq surface, map-key==id read guard (ADR-0023, Task 2) -

describe("proposal mailbox — provenance (sig, seq, map-key guard)", () => {
  // A trivial fake signer: we are NOT testing crypto here, only that the `sig`
  // field round-trips publish → read. "AAAA" is a valid base64url string.
  const fakeSigner: ProposalSigner = async () => "AAAA";

  it("a record published WITH a signer carries `sig` and surfaces it on read", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id = await publishProposal(b, PROPOSAL, MCP, fakeSigner);
    expect(getProposal(b, id)?.sig).toBe("AAAA");
    expect(getPendingProposals(b)[0]?.sig).toBe("AAAA");
  });

  it("publishing WITHOUT a signer leaves `sig` absent and still reads (back-compat)", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id = await publishProposal(b, PROPOSAL, MCP);
    const rec = getProposal(b, id)!;
    expect(rec.sig).toBeUndefined();
    expect("sig" in rec).toBe(false); // exactOptionalPropertyTypes: omitted, not undefined
    expect(rec.request).toBe(PROPOSAL.request);
  });

  it("promotes `seq` onto the public read record", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id = await publishProposal(b, PROPOSAL, MCP);
    expect(typeof getProposal(b, id)?.seq).toBe("number");
    expect(typeof getProposals(b)[0]?.seq).toBe("number");
  });

  it("drops a record whose map KEY ≠ its signed `id` (record-swap guard)", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const honest = await publishProposal(b, PROPOSAL, MCP);

    // Forge a well-formed record whose own `id` disagrees with the map key it
    // is stored under — a relocated/swapped record a peer could write directly.
    b.doc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("id", "real-id");
      forged.set("filePath", "/main.typ");
      forged.set("baseText", "= Title\nbody\n");
      forged.set("proposedText", "= Title\nbody\nmore\n");
      forged.set("blocks", [{ search: "body\n", replace: "body\nmore\n" }]);
      forged.set("request", "swapped slot");
      forged.set("author", "mcp");
      forged.set("status", "pending");
      forged.set("createdAt", 0);
      forged.set("seq", 0);
      b.doc.getMap("mcpProposals").set("WRONG-KEY", forged as never);
    });

    // The honest record still surfaces; the key-mismatched record never does.
    expect(getProposals(b).map((p) => p.id)).toEqual([honest]);
    expect(getProposal(b, "WRONG-KEY")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runId grouping (ADR-0025 §5/§7, Task 2) — a non-authoritative UI read.
// ---------------------------------------------------------------------------

const FILE_INPUT: FileProposalInput = {
  request: "Add an intro chapter",
  ops: [
    {
      kind: "create",
      path: "/chapters/intro.typ",
      baseText: "",
      proposedText: "= Introduction\n",
      blocks: [],
    },
  ],
};

describe("getPendingRunGroups — collapse a run's pending proposals into one card", () => {
  it("(a) two records sharing a runId group together", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id1 = await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);
    const id2 = await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);

    const { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runId).toBe("r1");
    expect(groups[0]!.records.map((r) => r.id)).toEqual([id1, id2]);
    expect(groups[0]!.streaming).toBe(false);
    expect(groups[0]!.overflow).toBe(0);
  });

  it("(a') a single-file and a multi-file record with the same runId share one group", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const single = await publishProposal(b, { ...PROPOSAL, runId: "r9" }, MCP);
    const multi = await publishFileProposal(b, { ...FILE_INPUT, runId: "r9" }, MCP);

    const { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runId).toBe("r9");
    expect(new Set(groups[0]!.records.map((r) => r.id))).toEqual(new Set([single, multi]));
  });

  it("(b) records without a runId become singleton groups keyed by their own id", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id1 = await publishProposal(b, PROPOSAL, MCP);
    const id2 = await publishProposal(b, PROPOSAL, MCP);

    const { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.runId)).toEqual([id1, id2]);
    expect(groups.map((g) => g.records.map((r) => r.id))).toEqual([[id1], [id2]]);
  });

  it("(c) a runId longer than RUN_ID_MAX_LEN is treated as absent (clamped to a singleton)", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const tooLong = "x".repeat(RUN_ID_MAX_LEN + 1);
    const id = await publishProposal(b, { ...PROPOSAL, runId: tooLong }, MCP);

    // Read clamps runId to absent: the record reads with no runId...
    expect(getProposal(b, id)!.runId).toBeUndefined();
    expect("runId" in getProposal(b, id)!).toBe(false);
    // ...and groups as its OWN singleton keyed by id, never under the huge key.
    const { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runId).toBe(id);
    expect(groups[0]!.records.map((r) => r.id)).toEqual([id]);
  });

  it("(d) groups order by min seq, and records within a group order by seq", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    // Publish order: r2 first, then two r1 records. Group r1's min seq is LATER,
    // so r2 (older min seq) must sort before r1; within r1, publish (seq) order.
    const early = await publishProposal(b, { ...PROPOSAL, runId: "r2" }, MCP);
    const mid = await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);
    const late = await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);

    const { groups } = getPendingRunGroups(b);
    expect(groups.map((g) => g.runId)).toEqual(["r2", "r1"]);
    expect(groups[0]!.records.map((r) => r.id)).toEqual([early]);
    expect(groups[1]!.records.map((r) => r.id)).toEqual([mid, late]);
    // Intra-group seq is non-decreasing.
    const seqs = groups[1]!.records.map((r) => r.seq);
    expect(seqs[0]!).toBeLessThan(seqs[1]!);
  });

  it("(e) records-per-group overflow is FLAGGED and the newest are kept, never silently dropped", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const ids: string[] = [];
    for (let i = 0; i < RECORDS_PER_RUN_MAX + 3; i++) {
      ids.push(await publishProposal(b, { ...PROPOSAL, runId: "big" }, MCP));
    }

    const { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.records).toHaveLength(RECORDS_PER_RUN_MAX);
    expect(groups[0]!.overflow).toBe(3); // 3 beyond the cap, flagged not hidden
    // The NEWEST records are kept (tail), mirroring "showing newest N of M".
    expect(groups[0]!.records.map((r) => r.id)).toEqual(ids.slice(-RECORDS_PER_RUN_MAX));
  });

  it("(e') group-count overflow is FLAGGED with totalGroups; the newest runs are kept", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const runIds: string[] = [];
    for (let i = 0; i < RUN_GROUP_MAX + 2; i++) {
      const runId = `run-${String(i).padStart(4, "0")}`;
      runIds.push(runId);
      await publishProposal(b, { ...PROPOSAL, runId }, MCP);
    }

    const result = getPendingRunGroups(b);
    expect(result.groups).toHaveLength(RUN_GROUP_MAX);
    expect(result.totalGroups).toBe(RUN_GROUP_MAX + 2);
    expect(result.overflow).toBe(true);
    // Newest runs kept (the oldest 2 are the ones capped off the front).
    expect(result.groups.map((g) => g.runId)).toEqual(runIds.slice(-RUN_GROUP_MAX));
  });

  it("(f) a record published WITHOUT runId serializes byte-identically (no runId key in the CRDT)", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id = await publishProposal(b, PROPOSAL, MCP);

    // Inspect the raw nested Y.Map: the `runId` key must be entirely ABSENT, so
    // the security-pinned single-file record shape is unchanged from before.
    const raw = b.doc.getMap("mcpProposals").get(id) as Y.Map<unknown>;
    expect(raw.has("runId")).toBe(false);
    const fileId = await publishFileProposal(b, FILE_INPUT, MCP);
    const rawFile = b.doc.getMap("mcpFileProposals").get(fileId) as Y.Map<unknown>;
    expect(rawFile.has("runId")).toBe(false);
  });

  it("only PENDING records are grouped (resolved records drop out)", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const keep = await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);
    const gone = await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);
    resolveProposal(b, gone, "accepted", HUMAN);

    const { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.records.map((r) => r.id)).toEqual([keep]);
  });
});

// ---------------------------------------------------------------------------
// Run boundaries persisted in the CRDT (ADR-0025 §5, Task 3) — a sibling
// `mcpRuns` map keyed by runId records whether a run is still streaming, so a
// run card survives reload/disconnect. Grouping hint ONLY — never gates apply.
// ---------------------------------------------------------------------------

describe("run boundaries — markRunOpen / markRunClosed / readRunOpen", () => {
  it("markRunOpen then readRunOpen round-trips true; markRunClosed flips it false", () => {
    const a = new CollabProject();
    expect(readRunOpen(a, "r1")).toBe(false); // absent → not open (back-compat)
    markRunOpen(a, "r1", 1000);
    expect(readRunOpen(a, "r1")).toBe(true);
    markRunClosed(a, "r1", 2000);
    expect(readRunOpen(a, "r1")).toBe(false);
  });

  it("markRunClosed preserves startedAt and advances lastAt", () => {
    const a = new CollabProject();
    markRunOpen(a, "r1", 1000);
    markRunOpen(a, "r1", 1500); // a later proposal in the same open run
    markRunClosed(a, "r1", 3000);
    const run = a.doc.getMap("mcpRuns").get("r1") as Y.Map<unknown>;
    expect(run.get("open")).toBe(false);
    expect(run.get("startedAt")).toBe(1000); // first open wins
    expect(run.get("lastAt")).toBe(3000);
  });

  it("an absent mcpRuns map means no runs (legacy docs unaffected)", () => {
    const a = new CollabProject();
    expect(a.doc.getMap("mcpRuns").size).toBe(0);
    expect(readRunOpen(a, "anything")).toBe(false);
  });

  it("readRunOpen tolerates a forged/garbage entry (treated as not open)", () => {
    const a = new CollabProject();
    a.doc.transact(() => {
      a.doc.getMap("mcpRuns").set("garbage", "not a record" as never);
    });
    expect(readRunOpen(a, "garbage")).toBe(false);
  });

  it("run-state survives a Y.Doc serialize/reload (persisted alongside the mailbox)", () => {
    const a = new CollabProject();
    a.create("/main.typ", "= Title\nbody\n", HUMAN);
    markRunOpen(a, "r1", 1000);

    // Snapshot + reload into a fresh doc (the reload/disconnect path).
    const encoded = Y.encodeStateAsUpdate(a.doc);
    const reloaded = new CollabProject();
    Y.applyUpdate(reloaded.doc, encoded);
    expect(readRunOpen(reloaded, "r1")).toBe(true);

    // Closing on the reloaded peer is observed too.
    markRunClosed(reloaded, "r1", 2000);
    expect(readRunOpen(reloaded, "r1")).toBe(false);
  });
});

describe("getPendingRunGroups — streaming wired from persisted run state (Task 3)", () => {
  it("an OPEN run reports streaming:true; closing it flips streaming:false", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    markRunOpen(b, "r1", 1000);
    await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);
    await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);

    let { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runId).toBe("r1");
    expect(groups[0]!.streaming).toBe(true);

    markRunClosed(b, "r1", 2000);
    ({ groups } = getPendingRunGroups(b));
    expect(groups[0]!.streaming).toBe(false);
  });

  it("a legacy singleton (runId == record id, no run-state) is never streaming", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    const id = await publishProposal(b, PROPOSAL, MCP);

    const { groups } = getPendingRunGroups(b);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runId).toBe(id);
    expect(groups[0]!.streaming).toBe(false);
  });

  it("an open run with no run-state entry yet reads as not streaming (fail-safe)", async () => {
    const b = new CollabProject();
    b.create("/main.typ", "= Title\nbody\n", HUMAN);
    // runId present on records but NO mcpRuns entry — streaming must be false.
    await publishProposal(b, { ...PROPOSAL, runId: "r1" }, MCP);

    const { groups } = getPendingRunGroups(b);
    expect(groups[0]!.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// create-binary ops (A2) — a binary file POINTER carried in a multi-file
// proposal. Additive + backward-compatible: a text-only proposal is byte-for-
// byte unchanged (asserted by every test above). These pin the validator, the
// SEPARATE binary byte cap, and the read normalizer.
// ---------------------------------------------------------------------------
describe("create-binary ops (A2) — binary pointer in a multi-file proposal", () => {
  const HASH = "a".repeat(64);
  const goodBinary: FileProposalInput = {
    request: "Add a logo",
    ops: [
      {
        kind: "create-binary",
        path: "/logo.png",
        baseText: "",
        proposedText: "",
        blocks: [],
        binaryAsset: { type: "binary", hash: HASH, size: 1234, mime: "image/png" },
      },
    ],
  };

  it("a well-formed create-binary op publishes and reads back with its pointer", async () => {
    const { a, b, connA, connB } = twoPeers();
    void connA;
    void connB;
    const id = await publishFileProposal(b, goodBinary, MCP);
    const rec = getFileProposal(a, id);
    expect(rec).toBeDefined();
    expect(rec!.ops).toHaveLength(1);
    const op = rec!.ops[0]!;
    expect(op.kind).toBe("create-binary");
    expect(op.path).toBe("/logo.png");
    expect(op.binaryAsset).toEqual({ type: "binary", hash: HASH, size: 1234, mime: "image/png" });
    expect(op.baseText).toBe("");
    expect(op.proposedText).toBe("");
    expect(op.blocks).toEqual([]);
  });

  it("a create-binary op WITHOUT a binaryAsset is rejected at publish", () => {
    const v = fileProposalSizeViolation({
      request: "x",
      ops: [{ kind: "create-binary", path: "/a.png", baseText: "", proposedText: "", blocks: [] }],
    });
    expect(v).not.toBeNull();
  });

  it("a non-64-hex / non-positive / oversized binaryAsset is rejected", () => {
    const cases = [
      { type: "binary", hash: "A".repeat(64), size: 1, mime: "image/png" }, // uppercase hex
      { type: "binary", hash: "a".repeat(63), size: 1, mime: "image/png" }, // too short
      { type: "binary", hash: HASH, size: 0, mime: "image/png" }, // not positive
      { type: "binary", hash: HASH, size: 1.5, mime: "image/png" }, // not integer
      { type: "binary", hash: HASH, size: FILE_PROPOSAL_LIMITS.maxBlobBytes + 1, mime: "image/png" },
      { type: "binary", hash: HASH, size: 1, mime: "" }, // empty mime
    ];
    for (const binaryAsset of cases) {
      const v = fileProposalSizeViolation({
        request: "x",
        ops: [
          { kind: "create-binary", path: "/a.png", baseText: "", proposedText: "", blocks: [], binaryAsset: binaryAsset as never },
        ],
      });
      expect(v).not.toBeNull();
    }
  });

  it("a create-binary op with non-empty text/blocks is rejected", () => {
    const v = fileProposalSizeViolation({
      request: "x",
      ops: [
        {
          kind: "create-binary",
          path: "/a.png",
          baseText: "",
          proposedText: "not empty",
          blocks: [],
          binaryAsset: { type: "binary", hash: HASH, size: 1, mime: "image/png" },
        },
      ],
    });
    expect(v).not.toBeNull();
  });

  it("a NON-binary op carrying a binaryAsset is rejected", () => {
    const v = fileProposalSizeViolation({
      request: "x",
      ops: [
        {
          kind: "create",
          path: "/a.typ",
          baseText: "",
          proposedText: "hi",
          blocks: [],
          binaryAsset: { type: "binary", hash: HASH, size: 1, mime: "image/png" } as never,
        },
      ],
    });
    expect(v).not.toBeNull();
  });

  it("the binary byte budget is its OWN aggregate cap (not the text cap)", () => {
    // Two ops each half the blob cap + 1 byte → over the total blob cap.
    const half = Math.floor(FILE_PROPOSAL_LIMITS.maxTotalBlobBytes / 2) + 1;
    const v = fileProposalSizeViolation({
      request: "x",
      ops: [
        { kind: "create-binary", path: "/a.png", baseText: "", proposedText: "", blocks: [], binaryAsset: { type: "binary", hash: "a".repeat(64), size: half, mime: "image/png" } },
        { kind: "create-binary", path: "/b.png", baseText: "", proposedText: "", blocks: [], binaryAsset: { type: "binary", hash: "b".repeat(64), size: half, mime: "image/png" } },
      ],
    });
    expect(v).toContain("binary bytes");
  });

  it("a forged create-binary record with a malformed pointer is SKIPPED on read", async () => {
    const { a } = twoPeers();
    // Forge a record straight into the Y.Map (a hostile room peer) with a bad hash.
    const map = a.doc.getMap<Y.Map<unknown>>("mcpFileProposals");
    const rec = new Y.Map<unknown>();
    a.doc.transact(() => {
      rec.set("id", "forged-bin");
      rec.set("request", "x");
      rec.set("ops", [
        { kind: "create-binary", path: "/a.png", baseText: "", proposedText: "", blocks: [], binaryAsset: { type: "binary", hash: "zz", size: 1, mime: "image/png" } },
      ]);
      rec.set("author", "mcp");
      rec.set("status", "pending");
      rec.set("createdAt", 1);
      rec.set("seq", 0);
      map.set("forged-bin", rec);
    });
    expect(getFileProposal(a, "forged-bin")).toBeUndefined();
  });

  it("a text-only multi-file proposal still reads back with NO binaryAsset (back-compat)", async () => {
    const { a, b } = twoPeers();
    const id = await publishFileProposal(
      b,
      { request: "edit", ops: [{ kind: "create", path: "/x.typ", baseText: "", proposedText: "hi", blocks: [] }] },
      MCP,
    );
    const rec = getFileProposal(a, id)!;
    expect(rec.ops[0]!.binaryAsset).toBeUndefined();
  });
});
