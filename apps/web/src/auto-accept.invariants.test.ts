/**
 * ADR-0023 invariant pins — the load-bearing auto-accept guarantees, exercised
 * with the REAL crypto (deriveProposalKey + signProposal + verifyProposal) and a
 * REAL durable audit, not stubs. Where auto-accept.test.ts stubs the verify
 * verdict to test each gate in isolation, this composes the actual modules end to
 * end so a regression in the canonical serialization, the key derivation, or the
 * audit replay guard fails the gate.
 */
import { describe, it, expect } from "vitest";
import {
  deriveProposalKey,
  signProposal,
  verifyProposal,
  singleToSignable,
  type ProposalScope,
  type ProposalRecord,
  type ProjectSnapshot,
} from "@galley/collab";
import { AutoAcceptAudit } from "./auto-accept-audit.js";
import { decideAutoAcceptSingle, type AutoAcceptCtx } from "./auto-accept.js";
import type { SessionStoreLike } from "./control-responder-mount.js";

const RESPONSE_KEY = new Uint8Array(32).fill(3);
const scope: ProposalScope = {
  grantId: "g1",
  controlRoom: "ctl-0123456789abcdef",
  syncUrl: "ws://127.0.0.1:9",
  projectId: "p1",
  shareRoom: "share-aaaaaaaaaaaaaaaa",
  mailbox: "mcpProposals",
};

function fakeStore(): SessionStoreLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

const BASE = "= T\nbody\n";
const PROPOSED = "= T\nbody\nmore\n";
const BLOCKS = [{ search: "body\n", replace: "body\nmore\n" }];

function snap(text = BASE): ProjectSnapshot {
  return {
    files: [{ fileId: "f1", path: "/main.typ", text, deleted: false }],
    mainFileId: "f1",
    duplicatePaths: [],
  };
}

function rawRecord(over: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: "rec-1",
    author: "mcp",
    status: "pending",
    createdAt: 1,
    seq: 1,
    filePath: "/main.typ",
    baseText: BASE,
    proposedText: PROPOSED,
    blocks: BLOCKS,
    request: "more",
    ...over,
  };
}

async function signedWith(key: Uint8Array, over: Partial<ProposalRecord> = {}): Promise<ProposalRecord> {
  const rec = rawRecord(over);
  const k = await deriveProposalKey(key, scope);
  const sig = await signProposal(k, scope, singleToSignable(rec, rec.seq));
  return { ...rec, sig };
}

function ctx(over: Partial<AutoAcceptCtx> = {}): AutoAcceptCtx {
  const audit = new AutoAcceptAudit(fakeStore(), scope.grantId);
  const verify: AutoAcceptCtx["verify"] = async (s, signable, sig) => {
    const k = await deriveProposalKey(RESPONSE_KEY, s);
    return verifyProposal(k, s, signable, sig);
  };
  return {
    armed: true,
    canMutate: true,
    joinedSession: false,
    verify,
    scopeFor: () => scope,
    audit,
    snapshot: snap(),
    lastAppliedSeq: { mcpProposals: null, mcpFileProposals: null },
    volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 100, maxBytes: 1_000_000_000 },
    ...over,
  };
}

describe("auto-accept invariants (real crypto + real audit)", () => {
  it("a correctly-signed, armed, clean proposal is eligible to auto-apply", async () => {
    const d = await decideAutoAcceptSingle(await signedWith(RESPONSE_KEY), ctx());
    expect("apply" in d).toBe(true);
  });

  it("an UNSIGNED proposal is never eligible (downgrade → manual)", async () => {
    const signed = await signedWith(RESPONSE_KEY);
    const { sig: _drop, ...unsigned } = signed;
    const d = await decideAutoAcceptSingle(unsigned as ProposalRecord, ctx());
    expect("manual" in d).toBe(true);
  });

  it("a proposal signed with the WRONG key (forged room peer) is never eligible", async () => {
    const forged = await signedWith(new Uint8Array(32).fill(9));
    const d = await decideAutoAcceptSingle(forged, ctx());
    expect("manual" in d).toBe(true);
  });

  it("a tampered field after signing fails verification", async () => {
    const signed = await signedWith(RESPONSE_KEY);
    const d = await decideAutoAcceptSingle({ ...signed, proposedText: PROPOSED + "EVIL\n" }, ctx());
    expect("manual" in d).toBe(true);
  });

  it("a VIEWER never auto-applies even with a valid signature", async () => {
    const d = await decideAutoAcceptSingle(await signedWith(RESPONSE_KEY), ctx({ canMutate: false }));
    expect("manual" in d).toBe(true);
  });

  it("a joined session never auto-applies", async () => {
    const d = await decideAutoAcceptSingle(await signedWith(RESPONSE_KEY), ctx({ joinedSession: true }));
    expect("manual" in d).toBe(true);
  });

  it("an unarmed session never auto-applies", async () => {
    const d = await decideAutoAcceptSingle(await signedWith(RESPONSE_KEY), ctx({ armed: false }));
    expect("manual" in d).toBe(true);
  });

  it("REPLAY: a digest already tombstoned in the audit is never re-applied", async () => {
    const rec = await signedWith(RESPONSE_KEY);
    // Keep a reference to the FULL audit (ctx.audit is narrowed to `has`).
    const audit = new AutoAcceptAudit(fakeStore(), scope.grantId);
    const c = ctx({ audit });
    const first = await decideAutoAcceptSingle(rec, c);
    expect("apply" in first).toBe(true);
    if ("apply" in first) audit.mark(rec.id, first.apply.digest, "applied");
    const second = await decideAutoAcceptSingle(rec, c);
    expect("manual" in second).toBe(true);
  });

  it("a STALE proposal (live text moved past baseText) fails the conflict gate", async () => {
    const d = await decideAutoAcceptSingle(
      await signedWith(RESPONSE_KEY),
      ctx({ snapshot: snap("= T\nchanged\n") }),
    );
    expect("manual" in d).toBe(true);
  });
});

describe("arm/reattach promotion preserves every auto-accept invariant", () => {
  // `promotePendingToEligible` only marks an id seen+eligible in the eligibility
  // TRACKER — it never touches the decision core, so a "promoted" record is simply
  // one that reaches `decideAutoAcceptSingle`/`File`. These pins assert that even a
  // record that promotion would feed into the chain STILL fails closed at every
  // real authorization gate. (The tracker-level scoping/idempotence of promotion
  // itself is pinned in auto-accept.test.ts.)

  it("(a) a promoted but UNSIGNED record still fails the signature gate → manual", async () => {
    const signed = await signedWith(RESPONSE_KEY);
    const { sig: _drop, ...unsigned } = signed;
    const d = await decideAutoAcceptSingle(unsigned as ProposalRecord, ctx());
    expect("manual" in d).toBe(true);
  });

  it("(b) a promoted record whose digest is already tombstoned still fails the replay gate → manual", async () => {
    const rec = await signedWith(RESPONSE_KEY);
    const audit = new AutoAcceptAudit(fakeStore(), scope.grantId);
    const c = ctx({ audit });
    const first = await decideAutoAcceptSingle(rec, c);
    expect("apply" in first).toBe(true);
    if ("apply" in first) audit.mark(rec.id, first.apply.digest, "applied");
    // Promotion would re-feed it; the real audit tombstone still blocks.
    const replayed = await decideAutoAcceptSingle(rec, c);
    expect("manual" in replayed).toBe(true);
  });

  it("(c) a promoted record with seq <= lastAppliedSeq still fails the monotonic-seq gate → manual", async () => {
    const rec = await signedWith(RESPONSE_KEY, { seq: 5 });
    const d = await decideAutoAcceptSingle(
      rec,
      ctx({ lastAppliedSeq: { mcpProposals: 5, mcpFileProposals: null } }),
    );
    expect("manual" in d).toBe(true);
  });

  it("(d) a promoted record under canMutate:false still fails the viewer gate → manual", async () => {
    const d = await decideAutoAcceptSingle(await signedWith(RESPONSE_KEY), ctx({ canMutate: false }));
    expect("manual" in d).toBe(true);
  });
});
