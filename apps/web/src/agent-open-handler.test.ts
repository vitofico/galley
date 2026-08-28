import { describe, it, expect } from "vitest";
import {
  createAgentOpenHandler,
  REFUSAL_JOINED_SESSION,
  REFUSAL_WRONG_PROJECT,
  REFUSAL_CONSENT_BUSY,
  REFUSAL_TIMEOUT,
  REFUSAL_DENIED,
  REFUSAL_WITHDRAWN,
  REFUSAL_SHARE_UNAVAILABLE,
  type AgentOpenHandlerSeams,
  type ConsentOutcome,
} from "./agent-open-handler.js";
import type { OpenedProject, OpenProjectRefusal } from "./control-responder.js";

/**
 * Offline unit tests for the #16.3 agent open_project CONSENT HANDLER core —
 * the pure gate-ordering logic extracted from ProjectApp (SEC-16.3a/b). Every
 * side effect is a fake seam; no React, no modal, no relay, no IndexedDB.
 *
 * What they pin (the security contract):
 *   - SEC-16.3b: a joined/CONNECTED-boot session is refused OUTRIGHT — before
 *     the scope check, before any consent UI, before any share work.
 *   - SEC-16.3a: a request the kernel withdrew is refused WITHOUT minting a
 *     share — both when it was already withdrawn before the modal (never
 *     prompts) and when it was withdrawn DURING consent (approve → no share).
 *   - The pre-existing gates (scope, single-consent lock, deny/timeout,
 *     share-unavailable) keep their exact refusal copy and ordering.
 */

const HANDOFF: OpenedProject = {
  room: "share-purecore000000000000000",
  syncUrl: "ws://127.0.0.1:1234",
  mainFile: "main.typ",
  grantId: "g0aBcDeF1234_-ZyXwVu",
};

/** A distinct live binding the reuse fast-path hands back (vs the fresh HANDOFF). */
const REUSED: OpenedProject = {
  room: "share-reuse00000000000000000",
  syncUrl: "ws://127.0.0.1:1234",
  mainFile: "main.typ",
  grantId: "gReuse111111111_-ZyXwVu",
};

/** A distinct live binding the F13 headless-attach seam hands back. */
const HEADLESS: OpenedProject = {
  room: "share-headless00000000000000",
  syncUrl: "ws://127.0.0.1:1234",
  mainFile: "main.typ",
  grantId: "gHeadless11111_-ZyXwVuXX",
};

interface SeamLog {
  consentRequests: number;
  ensureCalls: number;
  reuseCalls: number;
  headlessCalls: number;
  pendingFlips: boolean[];
}

function makeSeams(
  over: Partial<AgentOpenHandlerSeams> & { outcome?: ConsentOutcome } = {},
): { seams: AgentOpenHandlerSeams; log: SeamLog } {
  const log: SeamLog = {
    consentRequests: 0,
    ensureCalls: 0,
    reuseCalls: 0,
    headlessCalls: 0,
    pendingFlips: [],
  };
  let pending = false;
  const { outcome = "approve", ...rest } = over;
  const seams: AgentOpenHandlerSeams = {
    projectId: "proj-current",
    joinedSession: false,
    isConsentPending: () => pending,
    setConsentPending: (p) => {
      pending = p;
      log.pendingFlips.push(p);
    },
    requestConsent: async () => {
      log.consentRequests += 1;
      return outcome;
    },
    getEnsureShared: () => async () => {
      log.ensureCalls += 1;
      return HANDOFF;
    },
    ...rest,
  };
  return { seams, log };
}

function refusalOf(result: OpenedProject | OpenProjectRefusal): string {
  expect("refused" in result).toBe(true);
  return (result as OpenProjectRefusal).refused;
}

describe("agent-open-handler — SEC-16.3b: joined/CONNECTED sessions are refused outright", () => {
  it("refuses with the joined-session reason and runs NO consent and NO share", async () => {
    const { seams, log } = makeSeams({ joinedSession: true });
    const handler = createAgentOpenHandler(seams);
    // Even a request naming the session's own "projectId" (which for a joiner
    // IS the share-room id) must be refused — that id is the very capability
    // SEC-16.3b exists to stop gating on.
    const result = await handler("proj-current", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_JOINED_SESSION);
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
  });

  it("the joined-session refusal wins over every later gate (checked first)", async () => {
    const { seams, log } = makeSeams({
      joinedSession: true,
      isConsentPending: () => true, // would be the busy refusal otherwise
    });
    const handler = createAgentOpenHandler(seams);
    const result = await handler("some-other-project", () => false);
    expect(refusalOf(result)).toBe(REFUSAL_JOINED_SESSION);
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
  });
});

describe("agent-open-handler — SEC-16.3a: a withdrawn request never mints a share", () => {
  it("withdrawn BEFORE the modal: refuses without ever prompting the user", async () => {
    const { seams, log } = makeSeams();
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current", () => false);
    expect(refusalOf(result)).toBe(REFUSAL_WITHDRAWN);
    expect(log.consentRequests).toBe(0); // never prompted
    expect(log.ensureCalls).toBe(0); // no room minted
  });

  it("withdrawn DURING consent: an approval after withdrawal does NOT run the share-upgrade", async () => {
    // The probe is live when the handler starts, then flips false while the
    // human deliberates — exactly the withdrawn-then-approved scenario.
    let live = true;
    let prompted = 0;
    const { seams, log } = makeSeams({
      requestConsent: async () => {
        prompted += 1;
        live = false; // the kernel withdraws while the modal is up
        return "approve";
      },
    });
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current", () => live);
    expect(refusalOf(result)).toBe(REFUSAL_WITHDRAWN);
    // The user WAS prompted (the withdrawal happened mid-consent)…
    expect(prompted).toBe(1);
    // …but the share-upgrade never ran: no room minted, no connection made.
    expect(log.ensureCalls).toBe(0);
  });

  it("still-live approval DOES share (the liveness gate only blocks withdrawn requests)", async () => {
    const { seams, log } = makeSeams();
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current", () => true);
    expect(result).toEqual(HANDOFF);
    expect(log.ensureCalls).toBe(1);
  });

  it("the shared handoff carries a non-empty grantId (ADR-0023 §1)", async () => {
    // The handler forwards the ensureShared seam's OpenedProject verbatim, so a
    // share-upgrade that mints a per-grant token surfaces it on the handoff the
    // kernel receives. (ProjectApp's ensureSharedForAgent mints it via
    // mintGrantId; here the fake seam returns one so the assertion stays focused
    // on the handler contract.)
    const { seams } = makeSeams();
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect("refused" in result).toBe(false);
    if (!("refused" in result)) {
      expect(typeof result.grantId).toBe("string");
      expect(result.grantId.length).toBeGreaterThan(0);
    }
  });

  it("a direct call without a probe behaves as before (default = live)", async () => {
    const { seams, log } = makeSeams();
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current");
    expect(result).toEqual(HANDOFF);
    expect(log.ensureCalls).toBe(1);
  });
});

describe("agent-open-handler — the pre-existing gates keep their copy and order", () => {
  it("scope: a request for a different project is refused before any consent", async () => {
    const { seams, log } = makeSeams();
    const handler = createAgentOpenHandler(seams);
    const result = await handler("some-other-project", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_WRONG_PROJECT);
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
  });

  it("single-consent lock: a second request while one is pending is refused", async () => {
    const { seams, log } = makeSeams({ isConsentPending: () => true });
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_CONSENT_BUSY);
    expect(log.consentRequests).toBe(0);
  });

  it("deny: refuses with the declined copy and never shares", async () => {
    const { seams, log } = makeSeams({ outcome: "deny" });
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_DENIED);
    expect(log.ensureCalls).toBe(0);
  });

  it("timeout: refuses with the not-approved-in-time copy and never shares", async () => {
    const { seams, log } = makeSeams({ outcome: "timeout" });
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_TIMEOUT);
    expect(log.ensureCalls).toBe(0);
  });

  it("share unavailable: an approval with no ensure-shared closure refuses", async () => {
    const { seams } = makeSeams({ getEnsureShared: () => null });
    const handler = createAgentOpenHandler(seams);
    const result = await handler("proj-current", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_SHARE_UNAVAILABLE);
  });

  it("reuse seam is never consulted on the default wiring (omitted → consent unchanged)", async () => {
    // No tryReuseGrant seam → the gate is byte-for-byte the pre-ADR-0024 flow.
    const { seams, log } = makeSeams();
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(result).toEqual(HANDOFF);
    expect(log.consentRequests).toBe(1);
    expect(log.ensureCalls).toBe(1);
  });
});

describe("agent-open-handler — ADR-0024 §3 reuse fast-path", () => {
  it("a reuse HIT returns the live binding with NO consent modal and NO share re-mint", async () => {
    const { seams, log } = makeSeams({
      tryReuseGrant: async (id) => {
        expect(id).toBe("proj-current");
        log.reuseCalls += 1;
        return REUSED;
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(result).toEqual(REUSED);
    expect(log.reuseCalls).toBe(1);
    // The whole consent path is skipped on a hit.
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
    // The single-consent lock was never even touched (no modal stacked).
    expect(log.pendingFlips).toEqual([]);
  });

  it("a reuse MISS (null) falls through to the FULL consent gate unchanged", async () => {
    const { seams, log } = makeSeams({
      tryReuseGrant: async () => {
        log.reuseCalls += 1;
        return null; // no grant / MAC fail / scope mismatch — fail closed
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(result).toEqual(HANDOFF);
    expect(log.reuseCalls).toBe(1);
    // Consent still ran and the share was minted the normal way.
    expect(log.consentRequests).toBe(1);
    expect(log.ensureCalls).toBe(1);
  });

  it("a THROWING reuse seam is treated as a miss → full consent (fail closed)", async () => {
    const { seams, log } = makeSeams({
      tryReuseGrant: async () => {
        log.reuseCalls += 1;
        throw new Error("reuse boom");
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(result).toEqual(HANDOFF);
    expect(log.reuseCalls).toBe(1);
    expect(log.consentRequests).toBe(1);
    expect(log.ensureCalls).toBe(1);
  });

  it("a JOINED session is refused BEFORE reuse is ever consulted (SEC-16.3b wins)", async () => {
    let reuseCalls = 0;
    const { seams } = makeSeams({
      joinedSession: true,
      tryReuseGrant: async () => {
        reuseCalls += 1;
        return REUSED;
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_JOINED_SESSION);
    // A joined session can NEVER reuse — the seam is not even called.
    expect(reuseCalls).toBe(0);
  });

  it("a DIFFERENT project is refused BEFORE reuse (scope gate wins)", async () => {
    let reuseCalls = 0;
    const { seams } = makeSeams({
      tryReuseGrant: async () => {
        reuseCalls += 1;
        return REUSED;
      },
    });
    const result = await createAgentOpenHandler(seams)("some-other-project", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_WRONG_PROJECT);
    expect(reuseCalls).toBe(0);
  });

  it("reuse fires BEFORE the single-consent lock (a hit ignores a pending lock)", async () => {
    // A reuse hit is a no-op success, so it must NOT be blocked by an in-flight
    // consent lock — the fast-path precedes the lock check.
    const { seams, log } = makeSeams({
      isConsentPending: () => true,
      tryReuseGrant: async () => {
        log.reuseCalls += 1;
        return REUSED;
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(result).toEqual(REUSED);
    expect(log.reuseCalls).toBe(1);
  });

  it("a request WITHDRAWN before reuse is refused WITHDRAWN and never reconnects (SEC-16.3a)", async () => {
    // The reconnect side effect is gated on liveness like the consent path: a
    // request already withdrawn when the handler runs must not invoke the seam.
    const { seams, log } = makeSeams({
      tryReuseGrant: async () => {
        log.reuseCalls += 1;
        return REUSED;
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => false);
    expect(refusalOf(result)).toBe(REFUSAL_WITHDRAWN);
    // The seam (and its reconnect) is never even called for a dead request.
    expect(log.reuseCalls).toBe(0);
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
  });

  it("isRequestLive is threaded INTO the reuse seam (so it can re-check after its await)", async () => {
    let seamSawLive: boolean | null = null;
    const { seams } = makeSeams({
      tryReuseGrant: async (_id, isRequestLive) => {
        seamSawLive = isRequestLive();
        return REUSED;
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(result).toEqual(REUSED);
    // The probe reached the seam so it can re-check liveness around its own await.
    expect(seamSawLive).toBe(true);
  });

  it("the consent lock is released after every outcome (incl. a throwing modal seam)", async () => {
    // Approve path: lock flips true then false.
    {
      const { seams, log } = makeSeams();
      await createAgentOpenHandler(seams)("proj-current", () => true);
      expect(log.pendingFlips).toEqual([true, false]);
    }
    // A modal seam that throws still releases the lock (finally).
    {
      const { seams, log } = makeSeams({
        requestConsent: async () => {
          throw new Error("modal exploded");
        },
      });
      await expect(createAgentOpenHandler(seams)("proj-current", () => true)).rejects.toThrow(
        "modal exploded",
      );
      expect(log.pendingFlips).toEqual([true, false]);
    }
  });
});

describe("agent-open-handler — F13 headless attach (the only scope-gate relaxation)", () => {
  it("a headless HIT for a NON-foreground project returns the binding with NO modal", async () => {
    const { seams, log } = makeSeams({
      tryHeadlessAttach: async (id, isRequestLive) => {
        // The seam is consulted for the NON-foreground project the agent asked for.
        expect(id).toBe("other-project-headless");
        expect(isRequestLive()).toBe(true);
        log.headlessCalls += 1;
        return HEADLESS;
      },
    });
    const result = await createAgentOpenHandler(seams)("other-project-headless", () => true);
    expect(result).toEqual(HEADLESS);
    expect(log.headlessCalls).toBe(1);
    // The whole consent path is skipped on a headless hit; the scope gate never fires.
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
    expect(log.pendingFlips).toEqual([]);
  });

  it("a headless MISS (null) for a non-foreground project falls through to REFUSAL_WRONG_PROJECT", async () => {
    const { seams, log } = makeSeams({
      tryHeadlessAttach: async () => {
        log.headlessCalls += 1;
        return null; // no standing grant / scope drift / expired — fail closed
      },
    });
    const result = await createAgentOpenHandler(seams)("other-project-headless", () => true);
    // A new/changed scope without a valid standing grant still hits the scope gate.
    expect(refusalOf(result)).toBe(REFUSAL_WRONG_PROJECT);
    expect(log.headlessCalls).toBe(1);
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
  });

  it("a THROWING headless seam is treated as a miss → REFUSAL_WRONG_PROJECT (fail closed)", async () => {
    const { seams, log } = makeSeams({
      tryHeadlessAttach: async () => {
        log.headlessCalls += 1;
        throw new Error("headless boom");
      },
    });
    const result = await createAgentOpenHandler(seams)("other-project-headless", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_WRONG_PROJECT);
    expect(log.headlessCalls).toBe(1);
  });

  it("a JOINED session is refused BEFORE headless attach is ever consulted (SEC-16.3b wins)", async () => {
    let headlessCalls = 0;
    const { seams } = makeSeams({
      joinedSession: true,
      tryHeadlessAttach: async () => {
        headlessCalls += 1;
        return HEADLESS;
      },
    });
    const result = await createAgentOpenHandler(seams)("other-project-headless", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_JOINED_SESSION);
    // A joined session can NEVER headless-attach — the seam is not even called.
    expect(headlessCalls).toBe(0);
  });

  it("the headless seam is NOT consulted for the FOREGROUND project (reuse owns that path)", async () => {
    // For the currently-open project the existing reuse fast-path (gate 1.5) is the
    // re-bind authority; the headless branch is scoped to NON-foreground ids only,
    // so the foreground path stays byte-for-byte unchanged.
    let headlessCalls = 0;
    const { seams, log } = makeSeams({
      tryHeadlessAttach: async () => {
        headlessCalls += 1;
        return HEADLESS;
      },
    });
    const result = await createAgentOpenHandler(seams)("proj-current", () => true);
    expect(result).toEqual(HANDOFF); // the normal consent + share path ran
    expect(headlessCalls).toBe(0);
    expect(log.consentRequests).toBe(1);
    expect(log.ensureCalls).toBe(1);
  });

  it("a request WITHDRAWN before headless attach is refused WITHDRAWN and never reconnects (SEC-16.3a)", async () => {
    const { seams, log } = makeSeams({
      tryHeadlessAttach: async () => {
        log.headlessCalls += 1;
        return HEADLESS;
      },
    });
    const result = await createAgentOpenHandler(seams)("other-project-headless", () => false);
    expect(refusalOf(result)).toBe(REFUSAL_WITHDRAWN);
    // The seam (and its reconnect) is never even called for a dead request.
    expect(log.headlessCalls).toBe(0);
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
  });

  it("isRequestLive is threaded INTO the headless seam (so it can re-check after its await)", async () => {
    let seamSawLive: boolean | null = null;
    const { seams } = makeSeams({
      tryHeadlessAttach: async (_id, isRequestLive) => {
        seamSawLive = isRequestLive();
        return HEADLESS;
      },
    });
    const result = await createAgentOpenHandler(seams)("other-project-headless", () => true);
    expect(result).toEqual(HEADLESS);
    expect(seamSawLive).toBe(true);
  });

  it("when the headless seam is OMITTED, a non-foreground request is refused as before", async () => {
    // The default/foreground wiring (no tryHeadlessAttach) keeps the scope gate
    // byte-for-byte: a different project is REFUSAL_WRONG_PROJECT, no relaxation.
    const { seams, log } = makeSeams();
    const result = await createAgentOpenHandler(seams)("some-other-project", () => true);
    expect(refusalOf(result)).toBe(REFUSAL_WRONG_PROJECT);
    expect(log.consentRequests).toBe(0);
    expect(log.ensureCalls).toBe(0);
  });

  it("headless attach precedes reuse: a non-foreground hit never consults tryReuseGrant", async () => {
    // tryReuseGrant is scoped to the foreground project (it runs after the scope
    // gate), so a non-foreground headless hit must short-circuit before it.
    let reuseCalls = 0;
    const { seams, log } = makeSeams({
      tryReuseGrant: async () => {
        reuseCalls += 1;
        return REUSED;
      },
      tryHeadlessAttach: async () => {
        log.headlessCalls += 1;
        return HEADLESS;
      },
    });
    const result = await createAgentOpenHandler(seams)("other-project-headless", () => true);
    expect(result).toEqual(HEADLESS);
    expect(log.headlessCalls).toBe(1);
    expect(reuseCalls).toBe(0);
  });
});
