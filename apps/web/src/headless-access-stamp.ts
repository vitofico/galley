/**
 * The per-grant HEADLESS ACTIVITY STAMP (F13, ADR-0026) — the `lastActiveAt`
 * value the background agent host consults to enforce the 7-day idle TTL on a
 * standing {@link ProposalGrant.persistentAccess} grant.
 *
 * WHY a separate stamp (not the grant blob): the grant blob is MAC'd and rewritten
 * only on a deliberate consent/mode change; the activity clock ticks on EVERY
 * successful headless apply, which is far more frequent and is NOT a security-
 * relevant field (it can only ever SHORTEN the window an attacker has — a tamper
 * that pushes it forward keeps the grant alive at most one more TTL, and one that
 * pushes it back expires it sooner, fail closed). Keeping it out of the MAC'd blob
 * avoids re-MACing on every apply and keeps {@link parseGrant} focused on the
 * authority fields. It is keyed by the opaque `grantId`, so it is scoped to one
 * grant and a Revoke (which deletes the grant) leaves at most a harmless orphan
 * integer that the next stamp/clear removes.
 *
 * The host attaches a non-foreground project's headless host ONLY when
 * `!headlessAccessExpired(lastActiveAt ?? grantedAt, now)` (proposal-grant.ts):
 * the stamp is the `lastActiveAt`, falling back to the grant's `grantedAt` when no
 * apply has happened yet. `now` is injected by the caller so the pure TTL helper
 * never reads the clock itself.
 *
 * FAIL CLOSED: an unreadable/absent/garbage stamp reads as null (→ the caller
 * falls back to `grantedAt`), never as a fresher-than-real time. All I/O is
 * best-effort and never throws — a storage failure just means the TTL is measured
 * from `grantedAt` (the conservative bound).
 */
import type { SessionStoreLike } from "./control-responder-mount.js";

/** Storage-key prefix for the per-grant headless activity stamp. */
const STAMP_KEY_PREFIX = "galley.agentAccess.headlessActive.";

/**
 * The localStorage key holding one grant's `lastActiveAt` stamp. Keyed by the
 * opaque `grantId` so stamps never collide across grants and a Revoke removes
 * exactly this grant's stamp. Exported so the manager can delete it on teardown.
 */
export function headlessStampKey(grantId: string): string {
  return `${STAMP_KEY_PREFIX}${grantId}`;
}

/**
 * Read a grant's `lastActiveAt` stamp, or null when absent/unreadable/garbage
 * (fail closed — the caller then measures the TTL from `grantedAt`). Accepts only
 * a safe non-negative integer (the same integral discipline the grant's
 * `grantedAt` uses); anything else reads as null. Never throws.
 */
export function readHeadlessStamp(store: SessionStoreLike | null, grantId: string): number | null {
  if (store === null || grantId === "") return null;
  let raw: string | null;
  try {
    raw = store.getItem(headlessStampKey(grantId));
  } catch {
    return null; // storage access can throw (privacy mode) — measure from grantedAt
  }
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * Persist a grant's `lastActiveAt` stamp (best-effort; never throws). Called on
 * each SUCCESSFUL headless apply with `Date.now()` so the idle clock restarts.
 * A non-finite/negative value is ignored (a publish-side bug must not write a
 * time the read side would then reject anyway). MONOTONIC: never moves the stamp
 * BACKWARDS, so a racing stale apply cannot shorten a fresher window.
 */
export function writeHeadlessStamp(
  store: SessionStoreLike | null,
  grantId: string,
  now: number,
): void {
  if (store === null || grantId === "") return;
  if (!Number.isFinite(now) || now < 0) return;
  const next = Math.trunc(now);
  const prior = readHeadlessStamp(store, grantId);
  if (prior !== null && prior >= next) return; // never regress a fresher stamp
  try {
    store.setItem(headlessStampKey(grantId), String(next));
  } catch {
    // best-effort: a failed write just means the TTL is measured from grantedAt
  }
}

/** Delete a grant's stamp (best-effort; never throws). Fired on Revoke/teardown. */
export function clearHeadlessStamp(store: SessionStoreLike | null, grantId: string): void {
  if (store === null || grantId === "") return;
  try {
    store.removeItem(headlessStampKey(grantId));
  } catch {
    // best-effort
  }
}
