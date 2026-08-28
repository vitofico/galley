/**
 * `useAgentApplyHost` (F13.3) — the headless React hook that runs ONE background
 * agent-apply host for a single persistentAccess grant whose project is NOT the
 * foregrounded editor document. It loads that project's CRDT from IndexedDB,
 * connects its already-consented share room as an `agentWorker` peer, observes the
 * two proposal mailboxes, and drives each pending record through the SHARED apply
 * core ({@link runAgentApply}) under the single-applier Web-Lock — the SAME
 * chokepoint the foreground editor uses (the decision logic is never forked).
 *
 * It renders NOTHING. The caller ({@link AgentBackgroundHosts}) mounts it hidden at
 * the app root and never unmounts it across route changes, so the host SURVIVES the
 * editor navigating away from the project.
 *
 * SECURITY POSTURE (all inherited from the shared core; this only wires it):
 *   - it attaches ONLY for a grant the manager already holds that carries
 *     `persistentAccess`, is exact-scope, and is NOT idle-expired (the caller gates
 *     `active` on {@link grantAuthorizesHeadlessAttach});
 *   - it SKIPS the foregrounded project (the caller passes `active=false` then) so
 *     two appliers never run for one project — and even if they did, the
 *     `withAutoApplierLock(grantId)` Web-Lock inside the core is the hard backstop;
 *   - it advertises `agentWorker:true` presence so the kernel never counts it as a
 *     watching human (honest `pending_review_unwatched`);
 *   - every apply still runs the full gate chain + checkpoint + tombstone + volume
 *     cap + live final gate inside the core; a durability fault PAUSES the host
 *     (it stops applying) rather than applying without a replay barrier;
 *   - each successful apply stamps `lastActiveAt` so the 7-day idle TTL clock
 *     restarts (the apply core's `onActive`).
 *
 * The verifier/audit/scope all come from the manager's existing single-grant
 * accessors (v1 single-grant host — one background grant at a time). A multi-grant
 * keyed store is a later follow-up.
 */
import { useEffect, useRef } from "react";
import {
  getPendingProposals,
  getPendingFileProposals,
  observeProposals,
  observeFileProposals,
  materializeProject,
  getProposal,
  getFileProposal,
  AGENT_WORKER_PRESENCE_FIELD,
  type ProposalRecord,
  type FileProposalRecord,
  type ProposalScope,
  type BlobStore,
  type BinaryAsset,
} from "@galley/collab";
import { createProjectSession, connectProjectSession } from "./project-session.js";
import { PersistentBlobStore, IndexeddbBlobBackend, blobDbName } from "./idb-blob-store.js";
import { IdbVersionStore } from "./idb-version-store.js";
import { getControlResponderManager } from "./control-responder-mount.js";
import { isAutoApplierOwner, claimAutoApplier, releaseAutoApplier } from "./auto-applier-ownership.js";
import { runAgentApply, type ApplyRecord, type AgentApplyDeps } from "./agent-apply-core.js";
import { makeHeadlessApplySeam } from "./agent-apply-seam.js";
import { writeHeadlessStamp } from "./headless-access-stamp.js";
import { verifyBinaryBlobsPresent } from "./file-proposal-accept.js";
import type { SessionStoreLike } from "./control-responder-mount.js";
import type { AutoAcceptCtx } from "./auto-accept.js";

/** The op/byte burst budget — the SAME bounds the foreground editor charges. */
const AUTO_ACCEPT_MAX_OPS = 500;
const AUTO_ACCEPT_MAX_BYTES = 16 * 1024 * 1024;
const utf8 = new TextEncoder();

/** One background grant the host runs for (the manager's active persistentAccess grant). */
export interface HeadlessHostGrant {
  grantId: string;
  controlRoom: string;
  projectId: string;
  shareRoom: string;
  syncUrl: string;
  mainFile: string;
}

/**
 * Run the headless apply host for `grant` while `active`. When `active` flips false
 * (the project came to the foreground, the grant expired/was revoked, or the host
 * is unmounting) the connection + observers tear down and no further apply happens.
 *
 * `store` is the localStorage-like seam the TTL stamp + grant read from (production
 * = window.localStorage via the manager). `now` is injectable for tests.
 */
export function useAgentApplyHost(opts: {
  grant: HeadlessHostGrant | null;
  active: boolean;
  store: SessionStoreLike | null;
  now?: () => number;
}): void {
  const { grant, active, store } = opts;
  const now = opts.now ?? Date.now;

  // Per-host mutable state, reset whenever the (grantId, active) identity changes.
  const inFlight = useRef<Set<string>>(new Set());
  const appliedVolume = useRef<{ ops: number; bytes: number }>({ ops: 0, bytes: 0 });
  const lastAppliedSeq = useRef<{ mcpProposals: number | null; mcpFileProposals: number | null }>({
    mcpProposals: null,
    mcpFileProposals: null,
  });
  // The apply chain serializes records so each apply reads a FRESH seq/volume snapshot.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pausedRef = useRef(false);

  useEffect(() => {
    if (!active || grant === null || store === null) return;
    // Fresh per-attach budgets/guards.
    inFlight.current = new Set();
    appliedVolume.current = { ops: 0, bytes: 0 };
    lastAppliedSeq.current = { mcpProposals: null, mcpFileProposals: null };
    chain.current = Promise.resolve();
    pausedRef.current = false;

    let torn = false;
    const versionStore = new IdbVersionStore();
    let blobStore: BlobStore | null = null;
    try {
      if (typeof indexedDB !== "undefined") {
        blobStore = new PersistentBlobStore(new IndexeddbBlobBackend(blobDbName(grant.projectId)));
      }
    } catch {
      blobStore = null;
    }

    // LOCAL session: loads the project's existing CRDT from its room-scoped idb draft
    // store (seedIfPristine is a no-op for an existing doc). projectId === the local
    // room id, the same key ProjectApp uses. `syncUrl: undefined` ⇒ the LOCAL branch
    // of createProjectSession (it is the share-room CONNECT below, not this config,
    // that joins the relay).
    const session = createProjectSession([], grant.mainFile, {
      enabled: false,
      syncUrl: undefined,
      room: grant.projectId,
    });
    const project = session.project;

    const teardown: Array<() => void> = [];

    void session.whenReady.then(() => {
      if (torn) return;
      // CONNECT the already-consented share room as an editor, with the export blob
      // channel when this project has a store. The grant is already live in the
      // manager, so the blob-terminal auth is built from the active grant.
      const mgr = getControlResponderManager();
      const auth = mgr.getBlobTerminalAuth();
      const blobOpts =
        blobStore === null
          ? undefined
          : auth === null
            ? { store: blobStore }
            : { store: blobStore, terminalSigner: auth.terminalSigner, terminalVerifier: auth.terminalVerifier };
      let conn;
      try {
        conn = connectProjectSession(session, grant.syncUrl, grant.shareRoom, {}, "editor", blobOpts);
      } catch {
        return; // could not connect — the host simply applies nothing
      }
      const connection = conn; // definitely assigned past the guard (catch returns)
      // F13: advertise the HONEST worker marker so the kernel does NOT count this as
      // a watching human peer (keeps pending_review_unwatched truthful). Preserve the
      // author/role connectProjectSession set; only ADD the agentWorker field.
      try {
        const live = connection.awareness.getLocalState() as Record<string, unknown> | null;
        connection.setPresence({
          ...(live ?? {}),
          author: session.author,
          role: "editor",
          [AGENT_WORKER_PRESENCE_FIELD]: true,
        });
      } catch {
        // best-effort: a presence failure does not stop applying (it would only,
        // at worst, let the kernel over-count a watcher — never under-count).
      }

      // Publish this tab's single-applier election claim for the grant (the coarse
      // hint; the Web-Lock is the hard guarantee). Retract on teardown.
      claimAutoApplier(connection.awareness, grant.grantId);
      teardown.push(() => releaseAutoApplier(connection.awareness));

      // Build the apply dependencies — every effect reusing the manager's existing
      // single-grant verifier/audit/scope, so a headless apply is gated identically
      // to the foreground.
      const buildCtx = (): AutoAcceptCtx => {
        const verifier = mgr.getProposalVerifier();
        const audit = mgr.getAudit();
        const vol = appliedVolume.current;
        return {
          armed: true,
          // L1: `canMutate` is hard-coded true here AND in finalGateInputs because a
          // headless host is, by construction, ALWAYS an EDITOR of the doc it loaded
          // — it connects its OWN local project with role "editor" (connectProjectSession
          // above), and there is no path by which it becomes a viewer (a viewer is a
          // JOINER of someone else's share, which the host never is — `joinedSession`
          // is likewise false). The live-role re-read the FOREGROUND editor does (its
          // role can drop to viewer on a share) is intentionally dropped: the host has
          // no such role to lose. The seam's `!canMutate` guard stays as defense in
          // depth (fail-closed if a future caller ever passes false), just dead today.
          canMutate: true,
          joinedSession: false,
          // A null verifier (grant cleared mid-flight) fails closed: verify → false.
          verify: verifier === null ? async () => false : verifier.verifyFor,
          scopeFor:
            verifier === null
              ? (mailbox): ProposalScope => ({
                  grantId: grant.grantId,
                  controlRoom: grant.controlRoom,
                  syncUrl: grant.syncUrl,
                  projectId: grant.projectId,
                  shareRoom: grant.shareRoom,
                  mailbox,
                })
              : verifier.scopeFor,
          audit: audit ?? { has: () => true }, // no audit → block everything (fail safe)
          snapshot: project.snapshot(),
          lastAppliedSeq: lastAppliedSeq.current,
          volume: {
            opsThisWindow: vol.ops,
            bytesThisWindow: vol.bytes,
            maxOps: AUTO_ACCEPT_MAX_OPS,
            maxBytes: AUTO_ACCEPT_MAX_BYTES,
          },
          ...(blobStore
            ? {
                binaryPresent: (binaryCreates: { path: string; asset: { hash: string } }[]) =>
                  verifyBinaryBlobsPresent(
                    binaryCreates as { path: string; asset: BinaryAsset }[],
                    blobStore,
                  ),
              }
            : {}),
        };
      };

      const applySeam = makeHeadlessApplySeam(project, blobStore, true);

      const deps = (audit: NonNullable<ReturnType<typeof mgr.getAudit>>): AgentApplyDeps => ({
        grantId: grant.grantId,
        buildCtx,
        audit,
        checkpoint: async (request: string): Promise<string | null> => {
          const outcome = materializeProject(project.snapshot());
          if (!outcome.ok) return null;
          try {
            const version = await versionStore.createVersion(
              grant.projectId,
              {
                name: `Auto-accept: ${request}`.slice(0, 200),
                message: "Before a signed MCP proposal (auto-accepted, background)",
                author: { name: "Galley agent", email: "agent@users.galley.local" },
              },
              outcome.result.files,
            );
            return version.id;
          } catch {
            return null;
          }
        },
        finalGateInputs: (rec: ApplyRecord) => {
          // L1 (eventual-consistency coupling): the host's captured `grant` (from
          // AgentBackgroundHosts, an emit ago) and the manager's live `this.grant`
          // (re-read here via getActiveGrantForProject) can momentarily disagree —
          // the persisted grant loads async on resume (loadPersistedGrant) and emits,
          // and recordGrant/setGrantMode/clearActiveGrant each emit. But that window
          // only ever WITHHOLDS the host: a not-yet-loaded / cleared / Ask grant makes
          // `mode` null/ask → the final gate fails closed and nothing applies. It can
          // never cause an apply the live grant would forbid (the apply reads the LIVE
          // verifier/audit/mode, not the captured copy). The host is re-evaluated on
          // every manager emit, so it converges to the live grant.
          const liveGrant = mgr.getActiveGrantForProject(grant.projectId, grant.shareRoom);
          const stillPending =
            (rec.kind === "single"
              ? getProposal(project, rec.record.id)
              : getFileProposal(project, rec.record.id))?.status === "pending";
          return {
            mode: liveGrant?.mode ?? null,
            canMutate: true,
            stillPending,
            ownsAutoApplier: isAutoApplierOwner(connection.awareness, grant.grantId),
          };
        },
        apply: applySeam,
        onApplied: (rec, bytes) => {
          const vol = appliedVolume.current;
          vol.ops += rec.kind === "single" ? 1 : rec.record.ops.length;
          vol.bytes += bytes;
          lastAppliedSeq.current[rec.kind === "single" ? "mcpProposals" : "mcpFileProposals"] =
            rec.record.seq;
        },
        onPause: () => {
          // Fail-closed durability fault: quiesce — stop feeding new records. The
          // human re-arms (via the foreground) / re-consents to resume.
          pausedRef.current = true;
        },
        // L1: the 7-day idle TTL this stamp drives bounds a FORGOTTEN-but-XSS-readable
        // standing grant — it is NOT a defense against a hostile-but-paired kernel.
        // A kernel that keeps sending signed proposals also keeps the grant "active",
        // so the TTL never lapses for an actively-abused grant; the explicit human
        // off-switch for that is Revoke (clearActiveGrant), which zeroes the grant +
        // content + audit + this stamp and detaches the host. The TTL's job is only to
        // cap the blast radius of a grant the human set up and forgot.
        onActive: () => writeHeadlessStamp(store, grant.grantId, now()),
        inFlight: inFlight.current,
      });

      const enqueue = (rec: ApplyRecord): void => {
        if (pausedRef.current) return;
        // FAIL CLOSED: no live durable audit (grant clearing / no store) → never
        // auto-apply (the `started` replay tombstone could not be written). Resolve
        // it ONCE per record at enqueue time and hand the non-null handle to deps, so
        // the core never receives a null audit.
        const audit = mgr.getAudit();
        if (audit === null) return;
        chain.current = chain.current.then(() => runAgentApply(rec, deps(audit))).catch(() => {});
      };

      const drainSingle = (): void => {
        if (pausedRef.current) return;
        for (const p of getPendingProposals(project) as ProposalRecord[]) {
          enqueue({ kind: "single", record: p });
        }
      };
      const drainFile = (): void => {
        if (pausedRef.current) return;
        for (const p of getPendingFileProposals(project) as FileProposalRecord[]) {
          enqueue({ kind: "file", record: p });
        }
      };
      drainSingle();
      drainFile();
      teardown.push(observeProposals(project, drainSingle));
      teardown.push(observeFileProposals(project, drainFile));
    });

    return () => {
      torn = true;
      for (const t of teardown) {
        try {
          t();
        } catch {
          /* best-effort */
        }
      }
      // Tearing down the session disconnects the share room + destroys the doc/blob
      // channel — the host leaves the room (so the kernel sees the worker drop).
      try {
        session.destroy();
      } catch {
        /* best-effort */
      }
    };
    // Re-attach when the grant identity or active flag changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, grant?.grantId, grant?.shareRoom, grant?.projectId, store, now]);
}
