/**
 * SINGLE-AUTO-APPLIER OWNERSHIP (ADR-0025 §3, design §8.2) — the multi-tab race
 * guard for MCP auto-apply. Two tabs that each resumed the SAME persisted grant
 * would both observe the same signed proposal land in the shared mailbox and both
 * try to auto-apply it. The durable tombstone audit is the BACKSTOP against an
 * actual double-apply, but a race against a per-tab audit blob is a hole we close
 * UPSTREAM here: at most ONE tab is the auto-applier for a given grant; every
 * other tab leaves the record pending for manual review.
 *
 * The election rides the collab awareness the share connection already exposes
 * (the same `getStates()` map presence uses). Each tab that COULD auto-apply
 * publishes an `autoApplier` claim into its own awareness state:
 *
 *     { autoApplier: { grantId, clientId } }
 *
 * The OWNER for a grant is the claimant with the LOWEST awareness MAP-KEY clientId
 * among every state that claims THAT grantId — a deterministic, leaderless election
 * every tab computes identically from the same replicated awareness map. The rank
 * is the awareness-assigned map KEY, NEVER the value's self-reported `claim.clientId`
 * (H3: a peer could forge a low value to win/deny; the key is not forgeable within
 * the map). No lease timer, no coordinator: awareness is liveness-tracked by
 * y-protocols, so a closed/stale tab drops out of `getStates()` and the next-lowest
 * claimant becomes owner.
 *
 * Awareness is still PEER-WRITABLE, so this election is a coarse HINT only; the hard
 * single-applier guarantee among same-origin tabs is the Web Locks API
 * ({@link withAutoApplierLock}). The durable tombstone audit remains the replay
 * backstop. All three layers compose.
 *
 * FAIL CLOSED (→ Ask): ownership is only ever asserted when it is UNAMBIGUOUS. Any
 * of — no awareness, an awareness map that has not yet replicated our own claim,
 * our own state missing/!claiming this grant, or our clientId not the minimum —
 * returns false, and the caller SKIPS auto-apply (the record stays pending). A
 * tab that is unsure NEVER applies.
 *
 * PURE over the `y-protocols` Awareness shape (only `clientID` + `getStates()` are
 * read; only `setLocalStateField`/`getLocalState` are written), so the unit gate
 * drives it with a tiny fake — no relay, no Y.Doc, no DOM.
 */

/** The awareness-state field key carrying a tab's auto-applier claim. */
export const AUTO_APPLIER_FIELD = "autoApplier";

/** One tab's published claim to be the auto-applier for a specific grant. */
export interface AutoApplierClaim {
  /** The grant this claim is scoped to — a claim only counts for ITS grantId. */
  grantId: string;
  /**
   * The claimant's self-reported clientId. NON-AUTHORITATIVE (H3): the election
   * ranks by the awareness MAP KEY, never this field (a peer could forge it). Kept
   * only so a claim reads consistently before a peer's full state replicates; the
   * comparison ignores it.
   */
  clientId: number;
}

/**
 * The minimal slice of a `y-protocols` Awareness this module reads/writes. The
 * real `Awareness` satisfies it structurally; the unit gate passes a fake. We read
 * only `clientID` + `getStates()` and write only via `setLocalStateField` /
 * `getLocalState` (so we never clobber the presence fields sharing the state).
 */
export interface AutoApplierAwareness {
  /** This tab's own awareness client id (its identity in `getStates()`). */
  readonly clientID: number;
  /** Every known peer's awareness state, keyed by clientId (incl. self). */
  getStates(): Map<number, Record<string, unknown>>;
  /** This tab's own current awareness state, or null/undefined when unset. */
  getLocalState?(): Record<string, unknown> | null;
  /** Set a single field of this tab's awareness state (leaves the rest intact). */
  setLocalStateField(field: string, value: unknown): void;
}

/**
 * Read a well-formed {@link AutoApplierClaim} out of one awareness state, or null
 * when the state carries no (valid) claim. Defensive: a peer could publish a
 * garbage `autoApplier` value, so every field is type-checked before it counts.
 */
function readClaim(state: Record<string, unknown> | null | undefined): AutoApplierClaim | null {
  if (typeof state !== "object" || state === null) return null;
  const raw = state[AUTO_APPLIER_FIELD];
  if (typeof raw !== "object" || raw === null) return null;
  const { grantId, clientId } = raw as Record<string, unknown>;
  if (typeof grantId !== "string" || grantId.length === 0) return null;
  if (typeof clientId !== "number" || !Number.isFinite(clientId)) return null;
  return { grantId, clientId };
}

/**
 * Publish THIS tab's claim to be the auto-applier for `grantId` into its own
 * awareness state (idempotent — re-publishing the same claim is a no-op write).
 * Carry the tab's own `clientID` in the claim so the election reads consistently
 * even before a peer's full state has replicated. Best-effort; never throws.
 */
export function claimAutoApplier(aw: AutoApplierAwareness | null, grantId: string): void {
  if (aw === null) return;
  try {
    const claim: AutoApplierClaim = { grantId, clientId: aw.clientID };
    aw.setLocalStateField(AUTO_APPLIER_FIELD, claim);
  } catch {
    // best-effort: a failed publish just means this tab won't win the election
    // (fail-closed — it will not auto-apply), never a throw out of the caller.
  }
}

/**
 * Retract THIS tab's auto-applier claim (clears the field). Used when auto-apply
 * is no longer eligible (grant cleared / mode flips to Ask / viewer / unmount) so
 * a stale claim from this tab cannot keep another tab from becoming owner. Best-
 * effort; never throws.
 */
export function releaseAutoApplier(aw: AutoApplierAwareness | null): void {
  if (aw === null) return;
  try {
    aw.setLocalStateField(AUTO_APPLIER_FIELD, null);
  } catch {
    // best-effort
  }
}

/**
 * Is THIS tab the single auto-applier owner for `grantId`? True ONLY when the
 * election is UNAMBIGUOUS in this tab's favor:
 *
 *   - awareness exists, and
 *   - this tab's OWN state carries a valid claim for exactly THIS grantId
 *     (we never own a grant we have not claimed — covers "own state missing"
 *     and "awareness not yet populated with our claim"), and
 *   - this tab's clientId is the MINIMUM among every state claiming this grantId.
 *
 * Any other shape FAILS CLOSED → false, and the caller leaves the record pending
 * (Ask). A tie is impossible: clientIds are unique per awareness, so the minimum
 * is a single tab.
 */
export function isAutoApplierOwner(aw: AutoApplierAwareness | null, grantId: string): boolean {
  if (aw === null) return false;
  let states: Map<number, Record<string, unknown>>;
  try {
    states = aw.getStates();
  } catch {
    return false; // a broken awareness never grants ownership (fail closed)
  }

  // H3: the election key is the awareness MAP KEY (the entry's ACTUAL clientID),
  // NEVER the value's self-reported `claim.clientId`. A peer could publish a claim
  // carrying a forged-low `clientId` to win/deny the election; we ignore that field
  // for comparison entirely and only trust the key the awareness protocol assigns.
  // (We still REQUIRE the claim to be present + grant-scoped to count, but a claim
  // whose self-reported clientId disagrees with its map key is not trusted as a
  // lower bidder — only the key ranks.)
  //
  // Our own claim MUST be present and scoped to this grant — read it under our own
  // clientID (the map key we own).
  const ownClaim = readClaim(states.get(aw.clientID));
  if (ownClaim === null || ownClaim.grantId !== grantId) return false;

  // The minimum MAP-KEY clientId among every entry whose claim is for THIS grant
  // wins — a deterministic, spoof-resistant election (the key is not peer-forgeable
  // within the awareness map).
  let minClientId = Infinity;
  for (const [keyClientId, state] of states) {
    const claim = readClaim(state);
    if (claim === null || claim.grantId !== grantId) continue;
    if (keyClientId < minClientId) minClientId = keyClientId;
  }
  // We are owner iff our own (map-key) id is that minimum.
  return aw.clientID === minClientId;
}

// ---------------------------------------------------------------------------
// H3 step 2 — the REAL same-origin mutual exclusion: the Web Locks API.
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the Web Locks API this module needs. The real
 * `navigator.locks` satisfies it structurally; the unit gate passes a fake (or
 * undefined, to exercise the fail-closed path).
 */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
}

/** The lock NAME for one grant's auto-applier — keyed by grant id (one critical section per grant). */
export function autoApplierLockName(grantId: string): string {
  return `galley.autoApplier.${grantId}`;
}

/** The outcome of an attempted lock-guarded run. */
export interface AutoApplierLockResult<T> {
  /** True only if the lock was acquired and `fn` actually ran. */
  ranWithLock: boolean;
  /** `fn`'s result, present only when `ranWithLock` is true. */
  result?: T;
}

/** Resolve the ambient `navigator.locks`, or null when unavailable (jsdom/old runtime). */
function defaultLockManager(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks ?? null;
}

/**
 * Run `fn` UNDER a same-origin Web Lock keyed by `grantId` — the HARD guarantee
 * that two TABS of the same user never both auto-apply for one grant (the awareness
 * election is only a coarse hint; awareness is peer-writable). Uses
 * `request(name, {ifAvailable:true}, …)`: if the lock is already held (by another
 * tab, or this tab's own in-flight apply) the callback receives `null` and we DO
 * NOT run — `{ ranWithLock: false }`.
 *
 * FAIL CLOSED: when the Web Locks API is unavailable (the test/jsdom env, an older
 * runtime) we DO NOT auto-apply at all — `{ ranWithLock: false }`, no `fn` call —
 * rather than fall back to an unguarded apply. Manual review still works. A throw
 * from the lock manager is also treated as "did not run" (fail closed).
 *
 * `locks` is injectable so the unit gate drives it with a fake; production omits it
 * and reads the ambient `navigator.locks`.
 */
export async function withAutoApplierLock<T>(
  grantId: string,
  fn: () => Promise<T>,
  locks?: LockManagerLike | null,
): Promise<AutoApplierLockResult<T>> {
  const mgr = locks === undefined ? defaultLockManager() : locks;
  if (mgr === null || typeof mgr.request !== "function") {
    return { ranWithLock: false }; // fail closed: no lock primitive → never auto-apply
  }
  try {
    return await mgr.request(autoApplierLockName(grantId), { ifAvailable: true }, async (lock) => {
      // `ifAvailable` hands back null when the lock is already held — do NOT run.
      if (lock === null) return { ranWithLock: false } as AutoApplierLockResult<T>;
      const result = await fn();
      return { ranWithLock: true, result };
    });
  } catch {
    // A lock-manager throw must never become an unguarded apply (fail closed).
    return { ranWithLock: false };
  }
}
