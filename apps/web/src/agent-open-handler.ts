/**
 * The #16.3 agent `open_project` CONSENT HANDLER core — the pure gating logic
 * ProjectApp registers with the control-responder mount
 * (control-responder-mount.ts `registerOpenProjectHandler`). Extracted from the
 * inline ProjectApp handler so the consent ORDERING is unit-testable offline
 * (SEC-16.3a/b): every side effect (the blocking modal, the consent lock ref,
 * the share-upgrade) is an injected seam; this module only sequences them.
 *
 * The gate order is security-relevant and MUST stay:
 *   0. SEC-16.3b — a joined/CONNECTED-boot session is refused outright: a
 *      joiner does not OWN the project it is visiting, and its "projectId" is
 *      the share-room id itself, so the currently-open-project scope check
 *      would gate on a capability the requester may already hold. Fail closed
 *      before any consent UI.
 *   1. Scope — only the currently-open project may be requested. (RELAXED by the
 *      F13 headless-attach branch below, and ONLY by it.)
 *   1.4 Headless attach (F13, ADR-0024 §3 / ADR-0026) — the ONE sanctioned bypass
 *      of the scope gate, sitting AFTER the joined-session refusal (which still
 *      wins) and BEFORE the scope check. It fires ONLY when `hasHeadlessGrant`
 *      reports a MAC-verified, EXACTLY-scope-matched, non-idle `persistentAccess`
 *      grant for the requested project — i.e. the human granted standing headless
 *      access to THAT project once and it has not gone idle past the TTL. The seam
 *      owns the full check (MAC, exact scope, TTL); a hit re-attaches the already-
 *      consented share WITHOUT a modal. It is liveness-gated exactly like the reuse
 *      fast-path (a withdrawn request fails closed to REFUSAL_WITHDRAWN and never
 *      reconnects). On ANY miss/doubt (no standing grant, scope drift, expired,
 *      throw) we fall through to the scope check — so a NEW/CHANGED scope still
 *      hits REFUSAL_WRONG_PROJECT or the full foreground modal (fail closed). When
 *      the seam is omitted (legacy/foreground wiring) the gate is byte-unchanged.
 *   1.5 Reuse fast-path (ADR-0024 §3) — AFTER the joined-session refusal and the
 *      scope check (so a joined session or a different project can NEVER reuse),
 *      consult `tryReuseGrant`: it returns a live binding ONLY when the active
 *      persisted grant MAC-verifies AND its canonical scope matches the request
 *      EXACTLY, and re-attaches the already-consented share. A hit skips the
 *      consent modal and the share re-mint. ANY miss/doubt (no grant, bad MAC,
 *      scope mismatch, no live session, the seam throws) returns null and we
 *      FALL THROUGH to full consent — fail-closed: reuse is purely additive and
 *      never weakens the gate.
 *   2. Single-consent lock — never stack modals.
 *   3. SEC-16.3a pre-check — a request the kernel ALREADY withdrew never
 *      prompts the user at all.
 *   4. The blocking consent modal (approve | deny | timeout).
 *   5. SEC-16.3a re-check — consent can take up to 90s; if the kernel withdrew
 *      the request while the modal was up, an approval must NOT mint/connect a
 *      share room (previously the share went live with no listener; the mount's
 *      guardrail #5 only suppressed the RESPONSE). Re-check liveness BEFORE the
 *      share-upgrade runs.
 *   6. The (idempotent) share-upgrade.
 */
import type { OpenedProject, OpenProjectRefusal } from "./control-responder.js";

/** The consent modal's decision (ProjectApp's 90s auto-deny maps to "timeout"). */
export type ConsentOutcome = "approve" | "deny" | "timeout";

/** SEC-16.3b: a joined/CONNECTED session never shares the project it is visiting. */
export const REFUSAL_JOINED_SESSION =
  "this session joined someone else's shared project — only a project this browser owns can be shared with the agent";
export const REFUSAL_WRONG_PROJECT =
  "only the currently-open project can be shared with the agent right now";
export const REFUSAL_CONSENT_BUSY = "another agent request is awaiting your decision";
export const REFUSAL_TIMEOUT = "the request to share this project was not approved in time";
export const REFUSAL_DENIED = "the request to share this project was declined";
/** SEC-16.3a: the request vanished (kernel withdrew) — nothing was shared. */
export const REFUSAL_WITHDRAWN =
  "the agent withdrew this request before the project was shared — nothing was shared";
export const REFUSAL_SHARE_UNAVAILABLE = "sharing is unavailable right now";

/**
 * Everything the handler needs from ProjectApp, injected so the gate order is
 * testable offline (no React, no modal, no relay).
 */
export interface AgentOpenHandlerSeams {
  /** The stable id of the currently-open project (`config.room ?? "default"`). */
  projectId: string;
  /**
   * TRUE when this session BOOTED connected (a `/join/<room>` joiner or any
   * `?sync=` CONNECTED boot) — SEC-16.3b refuses those outright.
   */
  joinedSession: boolean;
  /** Read the single-consent lock (a ref in ProjectApp — synchronously correct). */
  isConsentPending(): boolean;
  /** Flip the single-consent lock. */
  setConsentPending(pending: boolean): void;
  /**
   * Open the blocking consent modal and resolve the human's decision. The seam
   * owns the modal lifecycle (render, 90s auto-deny timer, cleanup) — this
   * module only sequences around it.
   */
  requestConsent(): Promise<ConsentOutcome>;
  /**
   * The (idempotent) share-upgrade, read at CALL time (ProjectApp keeps the
   * latest closure in a ref), or null when sharing is unavailable.
   */
  getEnsureShared(): (() => Promise<OpenedProject | OpenProjectRefusal>) | null;
  /**
   * ADR-0024 §3 reuse fast-path. Resolve a LIVE binding for `requestedProjectId`
   * to REUSE — without re-consent or a share re-mint — ONLY when ALL of:
   *   - there is a live Agent Access session (responseKey present);
   *   - the persisted grant MAC-verifies under that session key (ADR-0023 §4);
   *   - the grant's canonical scope `{controlRoom, syncUrl, projectId, shareRoom,
   *     mainFile}` matches THIS request EXACTLY;
   *   - the share for that grant is (or can be) re-attached.
   * Returns the live `OpenedProject` binding on a hit, or null on ANY miss/doubt
   * (no grant, MAC fail, scope mismatch, no session, an error) — the handler then
   * falls through to the full consent gate (FAIL CLOSED). The seam itself owns the
   * MAC + exact-scope check and the re-attach side effect; this module only
   * sequences it after the joined-session + scope gates. Optional: when omitted
   * (a direct/legacy wiring) reuse never fires and consent is unchanged.
   *
   * `isRequestLive` (SEC-16.3a) is threaded in so the seam can re-check liveness
   * AFTER any internal `await` (e.g. session readiness) and BEFORE its reconnect
   * side effect — a request the kernel withdrew mid-await must NOT reopen a share
   * room. The handler ALSO pre-checks liveness before invoking the seam at all.
   */
  tryReuseGrant?: (
    requestedProjectId: string,
    isRequestLive: () => boolean,
  ) => Promise<OpenedProject | null>;
  /**
   * F13 (headless attach, ADR-0024 §3 / ADR-0026) — the ONLY relaxation of the
   * currently-open-project scope gate. Resolve a LIVE binding for a NON-foreground
   * project to re-attach — without re-consent or a modal — ONLY when the human
   * granted STANDING headless access (`persistentAccess`) to EXACTLY this project
   * once and it has not gone idle past the TTL. The seam owns the full check:
   *   - a persisted grant for `requestedProjectId` that MAC-verifies under the live
   *     session key (ADR-0023 §4);
   *   - `grantAuthorizesHeadlessAttach` true — `persistentAccess` set, the grant's
   *     canonical scope matches the live request EXACTLY, AND `lastActiveAt` is
   *     within {@link HEADLESS_ACCESS_IDLE_TTL_MS} of `now` (proposal-grant.ts);
   *   - the share for that grant is (or can be) re-attached.
   * Returns the live `OpenedProject` on a hit, or null on ANY miss/doubt (no
   * standing grant, scope drift, expired TTL, no session, an error) — the handler
   * then falls through to the SCOPE gate (so a new/changed scope still gets
   * REFUSAL_WRONG_PROJECT or the full foreground modal). FAIL CLOSED.
   *
   * Distinct from {@link tryReuseGrant}: reuse re-binds the CURRENTLY-OPEN project
   * (it runs AFTER the scope gate); this re-binds a project that is NOT the active
   * editor document (it runs BEFORE the scope gate, and is the only thing allowed
   * to pass a non-foreground projectId). It is liveness-gated identically: a
   * withdrawn request fails closed to REFUSAL_WITHDRAWN and never reconnects, and
   * `isRequestLive` is threaded in so the seam can re-check after its own await.
   *
   * Optional: when omitted (foreground/legacy wiring) the headless branch never
   * fires and the scope gate is byte-for-byte unchanged.
   */
  tryHeadlessAttach?: (
    requestedProjectId: string,
    isRequestLive: () => boolean,
  ) => Promise<OpenedProject | null>;
}

/**
 * Build the `open_project` handler ProjectApp registers with the mount. The
 * mount supplies `isRequestLive` per request (SEC-16.3a) — a probe that is TRUE
 * while the originating control request is still present in the mailbox. The
 * default (`() => true`) only applies to direct calls outside the mount and
 * preserves the consent gate unchanged there.
 */
export function createAgentOpenHandler(
  seams: AgentOpenHandlerSeams,
): (
  requestedProjectId: string,
  isRequestLive?: () => boolean,
) => Promise<OpenedProject | OpenProjectRefusal> {
  return async (requestedProjectId, isRequestLive = () => true) => {
    // 0. SEC-16.3b: refuse joined/CONNECTED sessions before anything else — a
    //    joiner doesn't own the project, and its projectId IS the room id.
    if (seams.joinedSession) {
      return { refused: REFUSAL_JOINED_SESSION };
    }
    // 1.4 Headless attach (F13): the ONLY relaxation of the scope gate, and it sits
    //     AFTER the joined-session refusal (which still wins) and BEFORE the scope
    //     check. A request for a NON-foreground project re-attaches its already-
    //     consented share — WITHOUT a modal — ONLY when the seam confirms a MAC-
    //     verified, exactly-scope-matched, non-idle `persistentAccess` grant for
    //     EXACTLY that project. The seam owns the full check; a hit returns the live
    //     binding, a miss/doubt returns null and we FALL THROUGH to the scope gate
    //     (so a new/changed scope still hits REFUSAL_WRONG_PROJECT or the full
    //     foreground modal — fail closed). A throwing seam is treated as a miss.
    //
    //     SEC-16.3a: like the reuse fast-path, headless attach has a RECONNECT side
    //     effect, so it is gated on request liveness. Pre-check here so a request the
    //     kernel ALREADY withdrew never reconnects; `isRequestLive` is ALSO handed to
    //     the seam so a request withdrawn DURING its internal await does not reconnect
    //     either. A withdrawn request fails closed to REFUSAL_WITHDRAWN (never a
    //     fall-through to the scope gate), matching the reuse path's own pre-check.
    if (seams.tryHeadlessAttach !== undefined && requestedProjectId !== seams.projectId) {
      if (!isRequestLive()) {
        return { refused: REFUSAL_WITHDRAWN };
      }
      let attached: OpenedProject | null = null;
      try {
        attached = await seams.tryHeadlessAttach(requestedProjectId, isRequestLive);
      } catch {
        attached = null; // fail closed: any headless error → the scope gate
      }
      if (attached !== null) return attached;
    }
    // 1. Scope: only the currently-open project may be shared with the agent.
    if (requestedProjectId !== seams.projectId) {
      return { refused: REFUSAL_WRONG_PROJECT };
    }
    // 1.5 Reuse fast-path (ADR-0024 §3): a request for THIS project (joined-session
    //     and scope gates already passed above) that has a MAC-verified, exactly-
    //     scope-matched persisted grant re-attaches its already-consented share
    //     WITHOUT a fresh modal or a share re-mint. The seam owns the MAC + exact-
    //     scope check; on a hit it returns the live binding, on ANY miss/doubt it
    //     returns null and we fall through to full consent (FAIL CLOSED — reuse is
    //     additive and can never weaken the gate). A throwing seam is treated as a
    //     miss for the same reason.
    //
    //     SEC-16.3a (HIGH fix): reuse has a RECONNECT side effect, so it is gated
    //     on request liveness exactly like the consent path. Pre-check here so a
    //     request the kernel ALREADY withdrew never reconnects; `isRequestLive` is
    //     ALSO handed to the seam so a request withdrawn DURING its internal await
    //     (session readiness) does not reconnect either. A withdrawn request fails
    //     closed to REFUSAL_WITHDRAWN (not a fall-through to consent) — matching the
    //     consent path's own pre-check, and never minting/reopening a live share.
    if (seams.tryReuseGrant !== undefined) {
      if (!isRequestLive()) {
        return { refused: REFUSAL_WITHDRAWN };
      }
      let reused: OpenedProject | null = null;
      try {
        reused = await seams.tryReuseGrant(requestedProjectId, isRequestLive);
      } catch {
        reused = null; // fail closed: any reuse error → full consent
      }
      if (reused !== null) return reused;
    }
    // 2. Single-consent lock: never stack modals.
    if (seams.isConsentPending()) {
      return { refused: REFUSAL_CONSENT_BUSY };
    }
    // 3. SEC-16.3a pre-check: an already-withdrawn request never prompts.
    if (!isRequestLive()) {
      return { refused: REFUSAL_WITHDRAWN };
    }
    seams.setConsentPending(true);
    let outcome: ConsentOutcome;
    try {
      // 4. The blocking modal (the seam owns its 90s auto-deny).
      outcome = await seams.requestConsent();
    } finally {
      seams.setConsentPending(false);
    }
    if (outcome === "timeout") {
      return { refused: REFUSAL_TIMEOUT };
    }
    if (outcome === "deny") {
      return { refused: REFUSAL_DENIED };
    }
    // 5. SEC-16.3a: consent took human time — if the kernel withdrew the
    //    request meanwhile, approving must NOT mint/connect a live share room
    //    (it would go live with no listener; only the response was suppressed
    //    before). Fail closed: refuse without touching the share state.
    if (!isRequestLive()) {
      return { refused: REFUSAL_WITHDRAWN };
    }
    // 6. Approved AND still live → run the (idempotent) share-upgrade.
    const ensure = seams.getEnsureShared();
    if (ensure === null) {
      return { refused: REFUSAL_SHARE_UNAVAILABLE };
    }
    return ensure();
  };
}
