import { describe, it, expect } from "vitest";
import type {
  FileProposalRecord,
  ProjectSnapshot,
  ProposalRecord,
  ProposalScope,
  SignableProposal,
} from "@galley/collab";
import {
  decideAutoAcceptFile,
  decideAutoAcceptSingle,
  passesFinalApplyGate,
  newAutoEligibility,
  observeAutoEligibility,
  promotePendingToEligible,
  type AutoAcceptCtx,
  type FinalApplyGateInput,
} from "./auto-accept.js";

// ---------------------------------------------------------------------------
// Fixtures: a hand-built snapshot, stub scopes, and the two record shapes. The
// crypto seams (verify/digest) run for real against globalThis.crypto in the
// vitest environment; only the verify VERDICT is stubbed per test.
// ---------------------------------------------------------------------------

function snap(
  files: { fileId: string; path: string; text: string; deleted?: boolean }[],
  binaryFiles?: { fileId: string; path: string; deleted?: boolean }[],
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
            hash: "h",
            size: 1,
            mime: "image/png",
            deleted: f.deleted ?? false,
          })),
        }
      : {}),
  };
}

const scope: ProposalScope = {
  grantId: "g1",
  controlRoom: "ctrl",
  syncUrl: "https://sync.example",
  projectId: "p1",
  shareRoom: "share1",
  mailbox: "mcpProposals",
};

const fileScope: ProposalScope = { ...scope, mailbox: "mcpFileProposals" };

const scopeFor: AutoAcceptCtx["scopeFor"] = (m) =>
  m === "mcpProposals" ? scope : fileScope;

/** A signed (sig present) single-file proposal whose blocks apply to LIVE_TEXT. */
const BASE = "= Title\nbody\n";
const PROPOSED = '= Title\nbody\n#include "x.typ"\n';
function single(over: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: "rec-1",
    author: "mcp",
    status: "pending",
    createdAt: 1000,
    seq: 5,
    sig: "AAAA",
    filePath: "/main.typ",
    baseText: BASE,
    proposedText: PROPOSED,
    blocks: [{ search: "body\n", replace: 'body\n#include "x.typ"\n' }],
    request: "add include",
    ...over,
  };
}

function fileRec(over: Partial<FileProposalRecord> = {}): FileProposalRecord {
  return {
    id: "frec-1",
    author: "mcp",
    status: "pending",
    createdAt: 1000,
    seq: 5,
    sig: "AAAA",
    request: "create + edit",
    ops: [
      { kind: "create", path: "/new.typ", baseText: "", proposedText: "= New\n", blocks: [] },
      {
        kind: "edit",
        path: "/main.typ",
        baseText: BASE,
        proposedText: PROPOSED,
        blocks: [{ search: "body\n", replace: 'body\n#include "x.typ"\n' }],
      },
    ],
    ...over,
  };
}

const liveSnap = () => snap([{ fileId: "m", path: "/main.typ", text: BASE }]);

/** A green context: every gate passes for both record shapes. */
function ctx(over: Partial<AutoAcceptCtx> = {}): AutoAcceptCtx {
  return {
    armed: true,
    canMutate: true,
    joinedSession: false,
    verify: async () => true,
    scopeFor,
    audit: { has: () => false },
    snapshot: liveSnap(),
    lastAppliedSeq: { mcpProposals: null, mcpFileProposals: null },
    volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 100, maxBytes: 1_000_000 },
    ...over,
  };
}

function reason(r: { apply: unknown } | { manual: string }): string | null {
  return "manual" in r ? r.manual : null;
}

describe("decideAutoAcceptSingle — fail-closed gates (one per gate)", () => {
  it("gate 1: unarmed → manual", async () => {
    const r = await decideAutoAcceptSingle(single(), ctx({ armed: false }));
    expect(reason(r)).toBe("auto-accept not armed");
  });

  it("gate 2: a viewer (canMutate:false) → manual", async () => {
    const r = await decideAutoAcceptSingle(single(), ctx({ canMutate: false }));
    expect(reason(r)).toBe("viewer/joined session cannot auto-apply");
  });

  it("gate 2: a joined session → manual", async () => {
    const r = await decideAutoAcceptSingle(single(), ctx({ joinedSession: true }));
    expect(reason(r)).toBe("viewer/joined session cannot auto-apply");
  });

  it("gate 3: a non-pending record → manual", async () => {
    const r = await decideAutoAcceptSingle(single({ status: "accepted" }), ctx());
    expect(reason(r)).toBe("proposal is not pending");
  });

  it("gate 5: verify→false → manual", async () => {
    const r = await decideAutoAcceptSingle(single(), ctx({ verify: async () => false }));
    expect(reason(r)).toBe("unsigned or unverified proposal");
  });

  it("gate 5: an UNSIGNED record (sig undefined) passes `undefined` to verify and is refused", async () => {
    let seen: unknown = "untouched";
    // Build a record with NO `sig` key at all (exactOptionalPropertyTypes) so the
    // gate genuinely sees `record.sig === undefined`, the unsigned-record case.
    const { sig: _omit, ...unsigned } = single();
    void _omit;
    const r = await decideAutoAcceptSingle(
      unsigned,
      ctx({
        verify: async (_s, _p, sig) => {
          seen = sig;
          return false; // a real verifier returns false for undefined
        },
      }),
    );
    expect(seen).toBeUndefined();
    expect(reason(r)).toBe("unsigned or unverified proposal");
  });

  it("gate 6: an audit hit (replay / corrupt audit) → manual", async () => {
    const r = await decideAutoAcceptSingle(single(), ctx({ audit: { has: () => true } }));
    expect(reason(r)).toBe("already auto-applied (replay)");
  });

  it("gate 7: a seq <= lastAppliedSeq (rollback/duplicate) → manual", async () => {
    const r = await decideAutoAcceptSingle(
      single({ seq: 5 }),
      ctx({ lastAppliedSeq: { mcpProposals: 5, mcpFileProposals: null } }),
    );
    expect(reason(r)).toBe("stale/duplicate seq");
  });

  it("gate 7: the seq high-water is PER MAILBOX — a single-file mark never blocks a fresh multi-file seq", async () => {
    // Regression: the kernel keeps two independent seq counters; a single shared
    // high-water mark would false-reject a multi-file proposal at fileSeq=0 once a
    // single-file proposal advanced the mark. The single-file slot must not gate the
    // file mailbox: seq 0 here is fresh for mcpFileProposals even though mcpProposals=5.
    const r = await decideAutoAcceptFile(
      fileRec({ seq: 0 }),
      ctx({ lastAppliedSeq: { mcpProposals: 5, mcpFileProposals: null } }),
    );
    expect(reason(r)).toBeNull();
  });

  it("gate 8: a volume burst over the budget → manual", async () => {
    const r = await decideAutoAcceptSingle(
      single(),
      ctx({ volume: { opsThisWindow: 100, bytesThisWindow: 0, maxOps: 100, maxBytes: 1_000_000 } }),
    );
    expect(reason(r)).toBe("volume budget exceeded");
  });

  it("gate 9: a stale baseText (planner conflict) → manual", async () => {
    // The live text moved past base AND the block no longer matches → no apply.
    const moved = snap([{ fileId: "m", path: "/main.typ", text: "= Title\nTOTALLY DIFFERENT\n" }]);
    const r = await decideAutoAcceptSingle(single(), ctx({ snapshot: moved }));
    expect(reason(r)).toBe("proposal conflicts with live text");
  });

  it("gate 9: 0 live matches for the target path → target conflict", async () => {
    const r = await decideAutoAcceptSingle(
      single(),
      ctx({ snapshot: snap([{ fileId: "x", path: "/other.typ", text: "x\n" }]) }),
    );
    expect(reason(r)).toBe("target conflict");
  });

  it("gate 9: >1 live matches (duplicate paths) → target conflict", async () => {
    const dup = snap([
      { fileId: "m1", path: "/main.typ", text: BASE },
      { fileId: "m2", path: "/main.typ", text: BASE },
    ]);
    const r = await decideAutoAcceptSingle(single(), ctx({ snapshot: dup }));
    expect(reason(r)).toBe("target conflict");
  });

  it("gate 9: a binary file collides with the target path → target conflict", async () => {
    const s = snap([{ fileId: "m", path: "/main.typ", text: BASE }], [{ fileId: "b", path: "/main.typ" }]);
    const r = await decideAutoAcceptSingle(single(), ctx({ snapshot: s }));
    expect(reason(r)).toBe("target conflict");
  });

  it("happy path: all gates pass → { apply } with the correct digest + normalized signable", async () => {
    const c = ctx();
    const r = await decideAutoAcceptSingle(single(), c);
    expect("apply" in r).toBe(true);
    if (!("apply" in r)) throw new Error("expected apply");
    expect(r.apply.kind).toBe("single");
    expect(r.apply.record.id).toBe("rec-1");
    // The signable is the normalized signing view (one synthetic edit op).
    expect(r.apply.signable.ops).toHaveLength(1);
    expect(r.apply.signable.ops[0]!.path).toBe("/main.typ");
    // The digest is exactly the keyless SHA-256 of (scope, signable).
    const { proposalSignedDigest } = await import("@galley/collab");
    const expected = await proposalSignedDigest(scope, r.apply.signable);
    expect(r.apply.digest).toBe(expected);
  });
});

describe("passesFinalApplyGate — the LAST gate before apply (ADR-0025 §8.1)", () => {
  const green: FinalApplyGateInput = {
    mode: "auto",
    canMutate: true,
    stillPending: true,
    ownsAutoApplier: true,
  };

  it("all-green → apply may proceed", () => {
    expect(passesFinalApplyGate(green)).toBe(true);
  });

  it("a flip to Ask between the TOCTOU re-check and apply HALTS the apply", () => {
    expect(passesFinalApplyGate({ ...green, mode: "ask" })).toBe(false);
  });

  it("a kill-switch (mode cleared to null) halts the apply", () => {
    expect(passesFinalApplyGate({ ...green, mode: null })).toBe(false);
  });

  it("a role drop to viewer mid-run halts the apply", () => {
    expect(passesFinalApplyGate({ ...green, canMutate: false })).toBe(false);
  });

  it("the record no longer pending (raced/withdrawn) halts the apply", () => {
    expect(passesFinalApplyGate({ ...green, stillPending: false })).toBe(false);
  });

  it("NOT the single-auto-applier owner → fail closed, leave pending", () => {
    expect(passesFinalApplyGate({ ...green, ownsAutoApplier: false })).toBe(false);
  });
});

describe("observeAutoEligibility — Ask→Auto affects FUTURE records only", () => {
  it("a record first seen under Ask is NOT eligible even after a flip to Auto", () => {
    const t = newAutoEligibility();
    // First sighting under Ask (the backlog) → ineligible, and stays ineligible.
    expect(observeAutoEligibility(t, "backlog", "ask")).toBe(false);
    // User flips to Auto; the SAME pending record is re-observed on a later refresh.
    expect(observeAutoEligibility(t, "backlog", "auto")).toBe(false);
  });

  it("a record first seen under Auto is eligible (and stays eligible)", () => {
    const t = newAutoEligibility();
    expect(observeAutoEligibility(t, "fresh", "auto")).toBe(true);
    // A later flip to Ask does not flip this verdict — the live final gate handles
    // the kill-switch; eligibility is only the Ask→Auto direction.
    expect(observeAutoEligibility(t, "fresh", "ask")).toBe(true);
  });

  it("first sight under null mode (no grant) is ineligible", () => {
    const t = newAutoEligibility();
    expect(observeAutoEligibility(t, "x", null)).toBe(false);
    expect(observeAutoEligibility(t, "x", "auto")).toBe(false);
  });

  it("a NEW record arriving after the flip to Auto IS eligible (future record)", () => {
    const t = newAutoEligibility();
    observeAutoEligibility(t, "backlog", "ask"); // pre-flip backlog
    // Flip to Auto, a brand-new record arrives — first seen under Auto.
    expect(observeAutoEligibility(t, "after-flip", "auto")).toBe(true);
    expect(observeAutoEligibility(t, "backlog", "auto")).toBe(false); // backlog still excluded
  });
});

describe("promotePendingToEligible — explicit arm / reattach promotion", () => {
  it("(a) a backlog seen under Ask becomes eligible after promotion (sticks across mode)", () => {
    const t = newAutoEligibility();
    // First sighting under Ask fixes it ineligible (future-records-only rule).
    expect(observeAutoEligibility(t, "backlog", "ask")).toBe(false);
    // An EXPLICIT arm/reattach promotes the currently-pending id.
    promotePendingToEligible(t, ["backlog"]);
    // A later passive re-sighting returns the promoted verdict regardless of mode.
    expect(observeAutoEligibility(t, "backlog", "ask")).toBe(true);
    expect(observeAutoEligibility(t, "backlog", "auto")).toBe(true);
  });

  it("(b) promoting a never-before-seen id makes it eligible and a later observe under null/ask stays true", () => {
    const t = newAutoEligibility();
    promotePendingToEligible(t, ["fresh"]);
    expect(observeAutoEligibility(t, "fresh", null)).toBe(true);
    expect(observeAutoEligibility(t, "fresh", "ask")).toBe(true);
  });

  it("(c) promoting an EMPTY iterable is a no-op", () => {
    const t = newAutoEligibility();
    promotePendingToEligible(t, []);
    expect(t.eligible.size).toBe(0);
    expect(t.seen.size).toBe(0);
    // An id seen under Ask stays ineligible (nothing was promoted).
    expect(observeAutoEligibility(t, "backlog", "ask")).toBe(false);
  });

  it("(d) promotion is scoped to exactly the listed ids — a different backlog id stays ineligible", () => {
    const t = newAutoEligibility();
    observeAutoEligibility(t, "promoted", "ask");
    observeAutoEligibility(t, "other", "ask");
    promotePendingToEligible(t, ["promoted"]);
    expect(observeAutoEligibility(t, "promoted", "ask")).toBe(true);
    expect(observeAutoEligibility(t, "other", "ask")).toBe(false); // not lifted
  });

  it("(e) idempotent — promoting the same id twice keeps it eligible and seen exactly once", () => {
    const t = newAutoEligibility();
    promotePendingToEligible(t, ["dup"]);
    promotePendingToEligible(t, ["dup"]);
    expect(t.eligible.size).toBe(1);
    expect(t.seen.size).toBe(1);
    expect(t.eligible.has("dup")).toBe(true);
    expect(t.seen.has("dup")).toBe(true);
  });
});

describe("Auto authenticity is independent of mode (ADR-0025 §8.1 invariant)", () => {
  it("an UNSIGNED record never auto-applies even with every other gate green", async () => {
    // mode==="auto" is enforced OUTSIDE the pure core (in the chain), so here the
    // green ctx already models 'armed/auto'. The signature gate must STILL reject
    // an unsigned record — auto only flips disposition, it never bypasses verify.
    const { sig: _omit, ...unsigned } = single();
    void _omit;
    const r = await decideAutoAcceptSingle(unsigned, ctx({ verify: async (_s, _p, sig) => sig != null }));
    expect(reason(r)).toBe("unsigned or unverified proposal");
  });

  it("a foreign-room record (verify→false) never auto-applies", async () => {
    const r = await decideAutoAcceptSingle(single(), ctx({ verify: async () => false }));
    expect(reason(r)).toBe("unsigned or unverified proposal");
  });
});

describe("decideAutoAcceptFile — fail-closed gates", () => {
  it("gate 1: unarmed → manual", async () => {
    const r = await decideAutoAcceptFile(fileRec(), ctx({ armed: false }));
    expect(reason(r)).toBe("auto-accept not armed");
  });

  it("gate 5: verify→false → manual", async () => {
    const r = await decideAutoAcceptFile(fileRec(), ctx({ verify: async () => false }));
    expect(reason(r)).toBe("unsigned or unverified proposal");
  });

  it("gate 8: volume counts EACH op (2 ops over a 1-op budget) → manual", async () => {
    const r = await decideAutoAcceptFile(
      fileRec(),
      ctx({ volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 1, maxBytes: 1_000_000 } }),
    );
    expect(reason(r)).toBe("volume budget exceeded");
  });

  it("gate 9: a planner conflict (create path already taken) surfaces the planner reason", async () => {
    const taken = snap([
      { fileId: "m", path: "/main.typ", text: BASE },
      { fileId: "n", path: "/new.typ", text: "old\n" },
    ]);
    const r = await decideAutoAcceptFile(fileRec(), ctx({ snapshot: taken }));
    expect(reason(r)).toMatch(/already exists/);
  });

  it("happy path: all gates pass → { apply } with the correct digest", async () => {
    const r = await decideAutoAcceptFile(fileRec(), ctx());
    expect("apply" in r).toBe(true);
    if (!("apply" in r)) throw new Error("expected apply");
    expect(r.apply.kind).toBe("file");
    expect(r.apply.signable.ops).toHaveLength(2);
    const { proposalSignedDigest } = await import("@galley/collab");
    const expected = await proposalSignedDigest(fileScope, r.apply.signable as SignableProposal);
    expect(r.apply.digest).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// A2 + B3: create-binary auto-accept — the byte burst budget counts binary
// `size`, and the blob-presence probe gates the DECISION (no tombstone written
// for a not-yet-present blob).
// ---------------------------------------------------------------------------
const HASH64 = "a".repeat(64);
function binFileRec(size: number, over: Partial<FileProposalRecord> = {}): FileProposalRecord {
  return fileRec({
    id: "bin-rec-1",
    ops: [
      {
        kind: "create-binary",
        path: "/logo.png",
        baseText: "",
        proposedText: "",
        blocks: [],
        binaryAsset: { type: "binary", hash: HASH64, size, mime: "image/png" },
      },
    ],
    ...over,
  });
}
const present = async () => ({ ok: true }) as const;

describe("decideAutoAcceptFile — create-binary (A2 byte budget + B3 presence gate)", () => {
  it("A2: a large create-binary proposal TRIPS the byte burst limiter (size is counted)", async () => {
    // proposedText is "" — without counting binaryAsset.size this would pass.
    const r = await decideAutoAcceptFile(
      binFileRec(2_000_000),
      ctx({
        binaryPresent: present,
        volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 100, maxBytes: 1_000_000 },
      }),
    );
    expect(reason(r)).toBe("volume budget exceeded");
  });

  it("A2: a small create-binary proposal stays UNDER the byte budget and applies", async () => {
    const r = await decideAutoAcceptFile(
      binFileRec(500),
      ctx({
        binaryPresent: present,
        snapshot: liveSnap(),
        volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 100, maxBytes: 1_000_000 },
      }),
    );
    expect("apply" in r).toBe(true);
  });

  it("B3: a NOT-yet-present blob → manual (no apply), so no tombstone is written upstream", async () => {
    const r = await decideAutoAcceptFile(
      binFileRec(500),
      ctx({ binaryPresent: async () => ({ ok: false, missingPath: "/logo.png" }) }),
    );
    expect(reason(r)).toContain("not yet present");
  });

  it("B3: NO binaryPresent probe → fail closed (a binary proposal never auto-applies)", async () => {
    // ctx() omits binaryPresent by default, so the gate sees it as absent.
    const r = await decideAutoAcceptFile(binFileRec(500), ctx());
    expect(reason(r)).toContain("no blob store");
  });

  it("B3: the presence probe is NOT consulted for a text-only proposal", async () => {
    let probed = false;
    const r = await decideAutoAcceptFile(
      fileRec(),
      ctx({
        binaryPresent: async () => { probed = true; return { ok: true }; },
        snapshot: liveSnap(),
      }),
    );
    expect("apply" in r).toBe(true);
    expect(probed).toBe(false);
  });
});
