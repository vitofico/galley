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
 * `locks` is injected by the caller; unavailable managers fail closed.
 */
export async function withAutoApplierLock<T>(
  grantId: string,
  fn: () => Promise<T>,
  locks?: LockManagerLike | null,
): Promise<AutoApplierLockResult<T>> {
  const mgr = locks ?? null;
  if (mgr === null || typeof mgr.request !== "function") {
    return { ranWithLock: false }; // fail closed: no lock primitive → never auto-apply
  }
  try {
    return await mgr.request(
      autoApplierLockName(grantId),
      { ifAvailable: true },
      async (lock) => {
        // `ifAvailable` hands back null when the lock is already held — do NOT run.
        if (lock === null)
          return { ranWithLock: false } as AutoApplierLockResult<T>;
        const result = await fn();
        return { ranWithLock: true, result };
      },
    );
  } catch {
    // A lock-manager throw must never become an unguarded apply (fail closed).
    return { ranWithLock: false };
  }
}
