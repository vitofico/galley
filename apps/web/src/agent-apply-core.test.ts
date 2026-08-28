import { describe, it, expect } from "vitest";
import {
  runAgentApply,
  PAUSE_AUDIT_FULL,
  PAUSE_TOMBSTONE_NONDURABLE,
  PAUSE_CHECKPOINT_FAILED,
  type AgentApplyDeps,
  type ApplyRecord,
} from "./agent-apply-core.js";
import type { AutoAcceptCtx } from "./auto-accept.js";
import { AutoAcceptAudit } from "./auto-accept-audit.js";
import { autoApplierLockName, type LockManagerLike } from "./auto-applier-ownership.js";
import type { ProposalRecord, ProjectSnapshot, ProposalScope, SignableProposal } from "@galley/collab";
import type { SessionStoreLike } from "./control-responder-mount.js";

/**
 * Offline unit tests for the PURE auto-apply run core (F13.3) — the lifted twin of
 * ProjectApp's `runAutoAccept` that BOTH the foreground editor and the headless
 * background host call, so the decision logic is never forked.
 *
 * What they pin (the apply invariants must hold identically for a headless host):
 *   - it drives the SAME decision core (an unsigned/unverified record never applies;
 *     a viewer/joined session never applies);
 *   - the `started` replay tombstone is written BEFORE the apply (checkpoint order);
 *   - a non-durable tombstone / full audit / failed checkpoint PAUSES, never applies;
 *   - the FINAL gate re-reads mode/role/pending/owner LIVE (Ask/viewer/lost-election
 *     → stays pending);
 *   - the apply runs UNDER the single-applier Web-Lock keyed by grantId, and a HELD
 *     lock (another tab/host applying) never double-applies (→ Ask);
 *   - a successful apply charges volume + stamps lastActiveAt.
 */

const SCOPE: ProposalScope = {
  grantId: "g-test",
  controlRoom: "ctl-0123456789abcdef",
  syncUrl: "ws://127.0.0.1:1234",
  projectId: "proj-1",
  shareRoom: `share-${"a1".repeat(16)}`,
  mailbox: "mcpProposals",
};

/** A pending single-file proposal targeting /main.typ (base "x" → "y"). */
function singleRecord(over: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: "rec-1",
    seq: 1,
    status: "pending",
    request: "do x",
    filePath: "/main.typ",
    baseText: "x",
    proposedText: "y",
    blocks: [{ search: "x", replace: "y" }],
    createdAt: 100,
    sig: "valid-sig",
    ...(over as object),
  } as ProposalRecord;
}

/** A live snapshot with /main.typ === "x" so the planner resolves cleanly. */
const SNAPSHOT: ProjectSnapshot = {
  files: [{ fileId: "f1", path: "/main.typ", text: "x", deleted: false } as never],
  binaryFiles: [],
  mainFileId: "f1",
} as unknown as ProjectSnapshot;

function makeStore(): SessionStoreLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** A Web-Locks manager that always grants the lock (single applier). */
const FREE_LOCK: LockManagerLike = {
  request: async (_name, _opts, cb) => cb({}),
};
/** A Web-Locks manager that reports the lock HELD (another tab/host applying). */
const HELD_LOCK: LockManagerLike = {
  request: async (_name, _opts, cb) => cb(null),
};

interface Harness {
  deps: AgentApplyDeps;
  applied: string[];
  pauses: string[];
  volume: { ops: number; bytes: number };
  audit: AutoAcceptAudit;
  active: number;
}

function harness(
  over: {
    ctx?: Partial<AutoAcceptCtx>;
    finalGate?: Partial<ReturnType<AgentApplyDeps["finalGateInputs"]>>;
    apply?: (frozen: unknown) => Promise<boolean>;
    checkpoint?: (request: string) => Promise<string | null>;
    locks?: LockManagerLike | null;
  } = {},
): Harness {
  const applied: string[] = [];
  const pauses: string[] = [];
  const volume = { ops: 0, bytes: 0 };
  let active = 0;
  const store = makeStore();
  const audit = new AutoAcceptAudit(store, "g-test");
  const baseCtx: AutoAcceptCtx = {
    armed: true,
    canMutate: true,
    joinedSession: false,
    verify: async () => true,
    scopeFor: () => SCOPE,
    audit,
    snapshot: SNAPSHOT,
    lastAppliedSeq: { mcpProposals: null, mcpFileProposals: null },
    volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 500, maxBytes: 16 * 1024 * 1024 },
    ...over.ctx,
  };
  const deps: AgentApplyDeps = {
    grantId: "g-test",
    buildCtx: () => ({ ...baseCtx, ...over.ctx }),
    audit,
    checkpoint: over.checkpoint ?? (async () => "ckpt-1"),
    finalGateInputs: () => ({
      mode: "auto",
      canMutate: true,
      stillPending: true,
      ownsAutoApplier: true,
      ...over.finalGate,
    }),
    apply:
      (over.apply as AgentApplyDeps["apply"]) ??
      (async (frozen) => {
        applied.push(frozen.record.id);
        return true;
      }),
    onApplied: (_rec, bytes) => {
      volume.ops += 1;
      volume.bytes += bytes;
    },
    onPause: (reason) => pauses.push(reason),
    onActive: () => {
      active += 1;
    },
    locks: over.locks === undefined ? FREE_LOCK : over.locks,
    inFlight: new Set<string>(),
  };
  return {
    deps,
    applied,
    pauses,
    volume,
    audit,
    get active() {
      return active;
    },
  } as Harness;
}

describe("runAgentApply — drives the SAME decision core (no fork)", () => {
  it("applies a signed, clean, armed single-file proposal under a free lock", async () => {
    const h = harness();
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual(["rec-1"]);
    expect(h.volume.ops).toBe(1);
    expect(h.volume.bytes).toBe(1); // "y"
    expect(h.audit.list().some((e) => e.state === "applied")).toBe(true);
  });

  it("an UNVERIFIED signature never applies (decision core rejects → manual)", async () => {
    const h = harness({ ctx: { verify: async () => false } });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual([]);
    // Fail-closed at the decision phase: no started tombstone, nothing applied.
    expect(h.audit.list()).toEqual([]);
  });

  it("a viewer / joined session never applies", async () => {
    const v = harness({ ctx: { canMutate: false } });
    await runAgentApply({ kind: "single", record: singleRecord() }, v.deps);
    expect(v.applied).toEqual([]);
    const j = harness({ ctx: { joinedSession: true } });
    await runAgentApply({ kind: "single", record: singleRecord() }, j.deps);
    expect(j.applied).toEqual([]);
  });
});

describe("runAgentApply — replay tombstone + checkpoint order, fail-closed pauses", () => {
  it("writes the `started` tombstone BEFORE applying (checkpoint sees it)", async () => {
    let stateAtCheckpoint: string | null = null;
    const h = harness({
      checkpoint: async () => {
        stateAtCheckpoint = "checked";
        return "ckpt-1";
      },
    });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    // The audit had a started→applied lifecycle; checkpoint ran after `started`.
    expect(stateAtCheckpoint).toBe("checked");
    expect(h.applied).toEqual(["rec-1"]);
  });

  it("a failed checkpoint PAUSES and never applies", async () => {
    const h = harness({ checkpoint: async () => null });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.pauses).toEqual([PAUSE_CHECKPOINT_FAILED]);
    expect(h.applied).toEqual([]);
  });
});

describe("runAgentApply — the live final gate is re-read at the apply instant", () => {
  it("a flip to Ask after the decision keeps the record pending (no apply)", async () => {
    const h = harness({ finalGate: { mode: "ask" } });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual([]);
    expect(h.audit.list().some((e) => e.state === "failed")).toBe(true);
  });

  it("losing the single-applier election (ownsAutoApplier false) keeps it pending", async () => {
    const h = harness({ finalGate: { ownsAutoApplier: false } });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual([]);
  });

  it("a role drop to viewer at the apply instant keeps it pending", async () => {
    const h = harness({ finalGate: { canMutate: false } });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual([]);
  });
});

describe("runAgentApply — the single-applier Web-Lock is the hard backstop", () => {
  it("a HELD lock (another tab/host applying) never double-applies → stays pending", async () => {
    const h = harness({ locks: HELD_LOCK });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual([]);
    expect(h.audit.list().some((e) => e.state === "failed")).toBe(true);
  });

  it("an UNAVAILABLE Web-Locks API never applies (fail closed)", async () => {
    const h = harness({ locks: null });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual([]);
  });

  it("worker + editor of the SAME grant never double-apply: the lock serializes them", async () => {
    // Model a single shared lock: the first holder runs, a concurrent second attempt
    // sees it HELD. The editor wins the lock and applies; the worker (concurrent) is
    // handed a null lock and does NOT apply — exactly the no-double-apply guarantee.
    let held = false;
    const sharedLock: LockManagerLike = {
      request: async (_name, _opts, cb) => {
        if (held) return cb(null); // already held → second caller does not run
        held = true;
        try {
          return await cb({});
        } finally {
          held = false;
        }
      },
    };
    const editorApplied: string[] = [];
    const workerApplied: string[] = [];
    const store = makeStore();
    const audit = new AutoAcceptAudit(store, "g-test");
    const mkDeps = (sink: string[]): AgentApplyDeps => ({
      grantId: "g-test",
      buildCtx: () => ({
        armed: true,
        canMutate: true,
        joinedSession: false,
        verify: async () => true,
        scopeFor: () => SCOPE,
        audit,
        snapshot: SNAPSHOT,
        lastAppliedSeq: { mcpProposals: null, mcpFileProposals: null },
        volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 500, maxBytes: 16 * 1024 * 1024 },
      }),
      audit,
      checkpoint: async () => "ckpt-1",
      finalGateInputs: () => ({ mode: "auto", canMutate: true, stillPending: true, ownsAutoApplier: true }),
      apply: async (frozen) => {
        sink.push(frozen.record.id);
        return true;
      },
      onApplied: () => {},
      onPause: () => {},
      locks: sharedLock,
      inFlight: new Set<string>(),
    });
    // Fire both concurrently on the SAME record id.
    const rec: ApplyRecord = { kind: "single", record: singleRecord() };
    await Promise.all([
      runAgentApply(rec, mkDeps(editorApplied)),
      runAgentApply(rec, mkDeps(workerApplied)),
    ]);
    // Exactly ONE of them applied — never both.
    expect(editorApplied.length + workerApplied.length).toBe(1);
  });

  it("foreground editor + background host (same grantId) SERIALIZE under galley.autoApplier.<grantId> — exactly one applies (M1 scenario barrier)", async () => {
    // The explicit two-applier integration the reviewer flagged: the M1 scenario
    // (a host attaching to the doc the editor is showing) has, as its SOLE hard
    // barrier, the grant-keyed Web-Lock. Model `navigator.locks.request(name,
    // {ifAvailable}, cb)` REALISTICALLY (per-NAME: while a name is held a concurrent
    // ifAvailable acquire gets null), shared between an "editor" runAgentApply and a
    // "host" runAgentApply BOTH keyed by the SAME grantId. Pin: (a) both request the
    // grant-keyed name galley.autoApplier.<grantId>, and (b) exactly ONE applies.
    const GRANT = "g-twoapplier";
    const held = new Set<string>();
    const requestedNames: string[] = [];
    // To ISOLATE the lock as the barrier we give the two appliers SEPARATE audits
    // (below), so the earlier decision-replay tombstone gate does NOT pre-empt the
    // second applier before it reaches the lock — in the real M1 scenario the shared
    // audit's tombstone serializes first and the lock is the backstop; here we force
    // BOTH to reach the lock so the lock itself is what's under test. A coordination
    // deferred makes the overlap deterministic: the first holder keeps the lock until
    // the second applier has actually requested it.
    let signalSecondReached!: () => void;
    const secondReached = new Promise<void>((r) => {
      signalSecondReached = r;
    });
    const perNameLock: LockManagerLike = {
      request: async (name, opts, cb) => {
        requestedNames.push(name);
        if (held.has(name)) {
          signalSecondReached(); // the holder may now proceed; the 2nd applier is here
          if (opts.ifAvailable) return cb(null); // held → the second applier does NOT run
          throw new Error("would block");
        }
        held.add(name);
        try {
          // Hold the lock until the SECOND applier has requested it, so the two
          // genuinely overlap and the lock is provably the decisive barrier.
          await secondReached;
          return await cb({});
        } finally {
          held.delete(name);
        }
      },
    };
    const editorApplied: string[] = [];
    const hostApplied: string[] = [];
    const mkDeps = (sink: string[]): AgentApplyDeps => {
      // SEPARATE audit per surface (distinct store): isolates the Web-Lock as the
      // sole serializer for this test (no cross-surface tombstone pre-emption).
      const audit = new AutoAcceptAudit(makeStore(), GRANT);
      return {
        grantId: GRANT,
        buildCtx: () => ({
          armed: true,
          canMutate: true,
          joinedSession: false,
          verify: async () => true,
          scopeFor: () => ({ ...SCOPE, grantId: GRANT }),
          audit,
          snapshot: SNAPSHOT,
          lastAppliedSeq: { mcpProposals: null, mcpFileProposals: null },
          volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 500, maxBytes: 16 * 1024 * 1024 },
        }),
        audit,
        checkpoint: async () => "ckpt-1",
        finalGateInputs: () => ({
          mode: "auto",
          canMutate: true,
          stillPending: true,
          ownsAutoApplier: true,
        }),
        apply: async (frozen) => {
          sink.push(frozen.record.id);
          return true;
        },
        onApplied: () => {},
        onPause: () => {},
        // DISTINCT inFlight sets — the two appliers are different surfaces (editor +
        // host), so the per-surface re-entrancy guard does NOT serialize them; only the
        // shared grant-keyed Web-Lock can. That is exactly what this test isolates.
        locks: perNameLock,
        inFlight: new Set<string>(),
      };
    };
    const rec: ApplyRecord = { kind: "single", record: singleRecord() };
    await Promise.all([
      runAgentApply(rec, mkDeps(editorApplied)),
      runAgentApply(rec, mkDeps(hostApplied)),
    ]);
    // (a) BOTH appliers contended on the grant-keyed lock NAME (no other name).
    expect(requestedNames.length).toBe(2);
    expect(requestedNames.every((n) => n === autoApplierLockName(GRANT))).toBe(true);
    expect(autoApplierLockName(GRANT)).toBe(`galley.autoApplier.${GRANT}`);
    // (b) Exactly ONE applied the record — the lock serialized the editor + host.
    expect(editorApplied.length + hostApplied.length).toBe(1);
  });

  it("two appliers with DIFFERENT grantIds do NOT serialize (distinct lock names → both apply)", async () => {
    // The flip side: serialization is SCOPED to the grant. Two unrelated grants must
    // not falsely block each other (the lock name differs), so both apply their own
    // record. This guards against an over-broad lock name.
    const held = new Set<string>();
    const perNameLock: LockManagerLike = {
      request: async (name, opts, cb) => {
        if (held.has(name)) {
          if (opts.ifAvailable) return cb(null);
          throw new Error("would block");
        }
        held.add(name);
        try {
          await Promise.resolve();
          return await cb({});
        } finally {
          held.delete(name);
        }
      },
    };
    const appliedA: string[] = [];
    const appliedB: string[] = [];
    const mkDeps = (grantId: string, sink: string[]): AgentApplyDeps => {
      const store = makeStore();
      const audit = new AutoAcceptAudit(store, grantId);
      return {
        grantId,
        buildCtx: () => ({
          armed: true,
          canMutate: true,
          joinedSession: false,
          verify: async () => true,
          scopeFor: () => ({ ...SCOPE, grantId }),
          audit,
          snapshot: SNAPSHOT,
          lastAppliedSeq: { mcpProposals: null, mcpFileProposals: null },
          volume: { opsThisWindow: 0, bytesThisWindow: 0, maxOps: 500, maxBytes: 16 * 1024 * 1024 },
        }),
        audit,
        checkpoint: async () => "ckpt-1",
        finalGateInputs: () => ({ mode: "auto", canMutate: true, stillPending: true, ownsAutoApplier: true }),
        apply: async (frozen) => {
          sink.push(frozen.record.id);
          return true;
        },
        onApplied: () => {},
        onPause: () => {},
        locks: perNameLock,
        inFlight: new Set<string>(),
      };
    };
    const rec: ApplyRecord = { kind: "single", record: singleRecord() };
    await Promise.all([
      runAgentApply(rec, mkDeps("grant-A", appliedA)),
      runAgentApply(rec, mkDeps("grant-B", appliedB)),
    ]);
    // Distinct grant-keyed locks → no false serialization → BOTH applied.
    expect(appliedA.length).toBe(1);
    expect(appliedB.length).toBe(1);
  });
});

describe("runAgentApply — re-entrancy + TTL stamp", () => {
  it("a successful headless apply fires onActive (the lastActiveAt stamp)", async () => {
    const h = harness();
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.active).toBe(1);
  });

  it("an in-flight id is a no-op (re-entrancy backstop)", async () => {
    const h = harness();
    h.deps.inFlight.add("rec-1");
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.applied).toEqual([]);
  });

  it("a TOCTOU-declining apply marks failed and does not charge volume", async () => {
    const h = harness({ apply: async () => false });
    await runAgentApply({ kind: "single", record: singleRecord() }, h.deps);
    expect(h.volume.ops).toBe(0);
    expect(h.audit.list().some((e) => e.state === "failed")).toBe(true);
  });
});
