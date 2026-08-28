import { describe, it, expect } from "vitest";
import {
  AUTO_APPLIER_FIELD,
  claimAutoApplier,
  isAutoApplierOwner,
  releaseAutoApplier,
  withAutoApplierLock,
  autoApplierLockName,
  type AutoApplierAwareness,
  type LockManagerLike,
} from "./auto-applier-ownership.js";

/**
 * A tiny fake of the `y-protocols` Awareness slice this module reads/writes. Each
 * fake shares ONE `states` map (the "replicated" awareness) so several fakes with
 * different clientIDs model several tabs in the same room.
 */
function fakeAwareness(
  clientID: number,
  states: Map<number, Record<string, unknown>>,
): AutoApplierAwareness {
  return {
    clientID,
    getStates: () => states,
    getLocalState: () => states.get(clientID) ?? null,
    setLocalStateField: (field, value) => {
      const prev = states.get(clientID) ?? {};
      if (value === null) {
        const { [field]: _omit, ...rest } = prev;
        void _omit;
        states.set(clientID, rest);
      } else {
        states.set(clientID, { ...prev, [field]: value });
      }
    },
  };
}

const GRANT = "grant-1";

describe("isAutoApplierOwner — single-applier election (fail closed)", () => {
  it("the lowest-clientId claimant for the grant is the owner", () => {
    const states = new Map<number, Record<string, unknown>>();
    const low = fakeAwareness(5, states);
    const high = fakeAwareness(9, states);
    claimAutoApplier(low, GRANT);
    claimAutoApplier(high, GRANT);
    expect(isAutoApplierOwner(low, GRANT)).toBe(true);
    expect(isAutoApplierOwner(high, GRANT)).toBe(false);
  });

  it("a SOLE claimant owns the grant", () => {
    const states = new Map<number, Record<string, unknown>>();
    const only = fakeAwareness(42, states);
    claimAutoApplier(only, GRANT);
    expect(isAutoApplierOwner(only, GRANT)).toBe(true);
  });

  it("FAIL CLOSED: null awareness → not owner", () => {
    expect(isAutoApplierOwner(null, GRANT)).toBe(false);
  });

  it("FAIL CLOSED: our own state is missing (we never published a claim) → not owner", () => {
    const states = new Map<number, Record<string, unknown>>();
    // Another tab claims; we (clientID 3) have NOT claimed, so no own state.
    claimAutoApplier(fakeAwareness(7, states), GRANT);
    const us = fakeAwareness(3, states);
    expect(isAutoApplierOwner(us, GRANT)).toBe(false);
  });

  it("FAIL CLOSED: awareness empty (no claims at all) → not owner", () => {
    const states = new Map<number, Record<string, unknown>>();
    expect(isAutoApplierOwner(fakeAwareness(1, states), GRANT)).toBe(false);
  });

  it("FAIL CLOSED: we claimed but a LOWER clientId also claims → not owner", () => {
    const states = new Map<number, Record<string, unknown>>();
    const us = fakeAwareness(8, states);
    claimAutoApplier(us, GRANT);
    claimAutoApplier(fakeAwareness(2, states), GRANT); // lower id claims after us
    expect(isAutoApplierOwner(us, GRANT)).toBe(false);
  });

  it("a claim for a DIFFERENT grant does not make us owner of THIS grant", () => {
    const states = new Map<number, Record<string, unknown>>();
    const us = fakeAwareness(4, states);
    claimAutoApplier(us, "other-grant");
    expect(isAutoApplierOwner(us, GRANT)).toBe(false);
  });

  it("a lower-clientId peer claiming a DIFFERENT grant does not steal ownership", () => {
    const states = new Map<number, Record<string, unknown>>();
    const us = fakeAwareness(6, states);
    claimAutoApplier(us, GRANT);
    claimAutoApplier(fakeAwareness(1, states), "other-grant"); // lower id, wrong grant
    expect(isAutoApplierOwner(us, GRANT)).toBe(true);
  });

  it("releaseAutoApplier drops our claim so the next-lowest peer becomes owner", () => {
    const states = new Map<number, Record<string, unknown>>();
    const low = fakeAwareness(5, states);
    const high = fakeAwareness(9, states);
    claimAutoApplier(low, GRANT);
    claimAutoApplier(high, GRANT);
    expect(isAutoApplierOwner(high, GRANT)).toBe(false);
    releaseAutoApplier(low);
    expect(isAutoApplierOwner(low, GRANT)).toBe(false); // we released; not owner
    expect(isAutoApplierOwner(high, GRANT)).toBe(true); // now the sole claimant
  });

  it("ignores a garbage autoApplier value published by a peer (defensive)", () => {
    const states = new Map<number, Record<string, unknown>>();
    const us = fakeAwareness(10, states);
    claimAutoApplier(us, GRANT);
    // A hostile/garbled peer at a LOWER id with a malformed claim must not win.
    states.set(2, { [AUTO_APPLIER_FIELD]: { grantId: 123, clientId: "nope" } });
    expect(isAutoApplierOwner(us, GRANT)).toBe(true);
  });

  it("H3: ignores a SPOOFED claim.clientId that disagrees with the map key", () => {
    // We are clientID 5 and the sole HONEST claimant. A hostile peer at map key 9
    // publishes a claim self-reporting clientId:1 — trying to look like the lowest
    // bidder and DENY us. The election must rank by the MAP KEY (9 > 5), not the
    // forged value, so we stay owner.
    const states = new Map<number, Record<string, unknown>>();
    const us = fakeAwareness(5, states);
    claimAutoApplier(us, GRANT);
    states.set(9, { [AUTO_APPLIER_FIELD]: { grantId: GRANT, clientId: 1 } });
    expect(isAutoApplierOwner(us, GRANT)).toBe(true);
  });

  it("H3: a spoofed-low claim cannot make the spoofer win either", () => {
    // The hostile tab IS at map key 9 but claims clientId 1; from its own vantage
    // the election still ranks it by key 9, so it loses to the real key-5 tab.
    const states = new Map<number, Record<string, unknown>>();
    const honest = fakeAwareness(5, states);
    claimAutoApplier(honest, GRANT);
    const spoofer = fakeAwareness(9, states);
    // The spoofer publishes a forged-low clientId rather than its real key.
    states.set(9, { [AUTO_APPLIER_FIELD]: { grantId: GRANT, clientId: 1 } });
    expect(isAutoApplierOwner(spoofer, GRANT)).toBe(false);
  });
});

describe("withAutoApplierLock — the hard same-origin single-applier guarantee (H3)", () => {
  it("autoApplierLockName is keyed by grant id", () => {
    expect(autoApplierLockName("g1")).toBe("galley.autoApplier.g1");
    expect(autoApplierLockName("g2")).not.toBe(autoApplierLockName("g1"));
  });

  it("FAIL CLOSED: navigator.locks unavailable (null) → does NOT run fn", async () => {
    let ran = false;
    const out = await withAutoApplierLock(
      GRANT,
      async () => {
        ran = true;
        return 1;
      },
      null, // no Web Locks API (jsdom / old runtime)
    );
    expect(out.ranWithLock).toBe(false);
    expect(out.result).toBeUndefined();
    expect(ran).toBe(false);
  });

  it("FAIL CLOSED: a lock-manager that throws → does NOT run fn", async () => {
    let ran = false;
    const throwing: LockManagerLike = {
      request: () => {
        throw new Error("boom");
      },
    };
    const out = await withAutoApplierLock(
      GRANT,
      async () => {
        ran = true;
        return 1;
      },
      throwing,
    );
    expect(out.ranWithLock).toBe(false);
    expect(ran).toBe(false);
  });

  it("runs fn under the lock when available, returning its result", async () => {
    // A simple non-contended fake: always grants the lock (a truthy handle).
    const grantingLocks: LockManagerLike = {
      request: async (_name, _opts, cb) => cb({}),
    };
    const out = await withAutoApplierLock(GRANT, async () => 7, grantingLocks);
    expect(out.ranWithLock).toBe(true);
    expect(out.result).toBe(7);
  });

  it("lock HELD ⇒ a second concurrent acquire (ifAvailable) does NOT run", async () => {
    // A realistic per-name fake of `request(name,{ifAvailable},cb)`: while a name is
    // held the callback gets null (ifAvailable semantics); otherwise it holds the
    // name for the callback's duration.
    const held = new Set<string>();
    const locks: LockManagerLike = {
      request: async (name, opts, cb) => {
        if (held.has(name)) {
          if (opts.ifAvailable) return cb(null);
          throw new Error("would block");
        }
        held.add(name);
        try {
          return await cb({});
        } finally {
          held.delete(name);
        }
      },
    };

    // Tab 1 acquires and stays inside the critical section until we release it.
    let release!: () => void;
    const inside = new Promise<void>((r) => (release = r));
    let firstRan = false;
    const first = withAutoApplierLock(
      GRANT,
      async () => {
        firstRan = true;
        await inside; // hold the lock
        return "a";
      },
      locks,
    );
    // Give tab 1 a tick to enter the section, then tab 2 tries concurrently.
    await Promise.resolve();
    let secondRan = false;
    const secondOut = await withAutoApplierLock(
      GRANT,
      async () => {
        secondRan = true;
        return "b";
      },
      locks,
    );
    expect(secondOut.ranWithLock).toBe(false); // lock held → did not run
    expect(secondRan).toBe(false);

    release();
    const firstOut = await first;
    expect(firstRan).toBe(true);
    expect(firstOut.ranWithLock).toBe(true);
    expect(firstOut.result).toBe("a");
  });
});
