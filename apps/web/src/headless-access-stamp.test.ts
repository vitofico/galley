import { describe, it, expect } from "vitest";
import {
  headlessStampKey,
  readHeadlessStamp,
  writeHeadlessStamp,
  clearHeadlessStamp,
} from "./headless-access-stamp.js";
import { headlessAccessExpired, HEADLESS_ACCESS_IDLE_TTL_MS } from "./proposal-grant.js";
import type { SessionStoreLike } from "./control-responder-mount.js";

/**
 * Offline unit tests for the per-grant HEADLESS ACTIVITY STAMP (F13) — the
 * `lastActiveAt` clock the background agent host consults against the 7-day idle
 * TTL. Pure storage helpers (a fake store); no DOM, no relay.
 *
 * What they pin:
 *   - round-trips a safe-integer stamp keyed by grantId (scoped, no collision);
 *   - reads garbage/absent/throwing storage as null (fail closed → grantedAt);
 *   - never regresses a fresher stamp (monotonic), ignores non-finite writes;
 *   - clear removes exactly this grant's stamp;
 *   - the stamp drives headlessAccessExpired exactly as the host will use it.
 */

function makeStore(initial: Record<string, string> = {}): {
  store: SessionStoreLike;
  map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  const store: SessionStoreLike = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
  return { store, map };
}

/** A store whose every access throws (privacy mode). */
const THROWING_STORE: SessionStoreLike = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("headless-access-stamp — round-trip + scoping", () => {
  it("writes then reads back a safe-integer stamp under a grant-scoped key", () => {
    const { store, map } = makeStore();
    writeHeadlessStamp(store, "grantA", 1_700_000_000_000);
    expect(readHeadlessStamp(store, "grantA")).toBe(1_700_000_000_000);
    expect(map.has(headlessStampKey("grantA"))).toBe(true);
    // A different grant has its own stamp; no collision.
    expect(readHeadlessStamp(store, "grantB")).toBeNull();
  });

  it("truncates a fractional now to an integer (matches grantedAt's integral discipline)", () => {
    const { store } = makeStore();
    writeHeadlessStamp(store, "grantA", 1_700_000_000_123.9);
    expect(readHeadlessStamp(store, "grantA")).toBe(1_700_000_000_123);
  });
});

describe("headless-access-stamp — fail closed", () => {
  it("absent stamp reads null", () => {
    const { store } = makeStore();
    expect(readHeadlessStamp(store, "grantA")).toBeNull();
  });

  it("a non-integer / negative / garbage stored value reads null", () => {
    const { store } = makeStore({
      [headlessStampKey("g1")]: "not-a-number",
      [headlessStampKey("g2")]: "-5",
      [headlessStampKey("g3")]: "1.5",
      [headlessStampKey("g4")]: "9007199254740993", // > MAX_SAFE_INTEGER
    });
    expect(readHeadlessStamp(store, "g1")).toBeNull();
    expect(readHeadlessStamp(store, "g2")).toBeNull();
    expect(readHeadlessStamp(store, "g3")).toBeNull();
    expect(readHeadlessStamp(store, "g4")).toBeNull();
  });

  it("a null store and an empty grantId read null and write nothing", () => {
    expect(readHeadlessStamp(null, "grantA")).toBeNull();
    const { store, map } = makeStore();
    writeHeadlessStamp(store, "", 123);
    writeHeadlessStamp(null, "grantA", 123);
    expect(map.size).toBe(0);
  });

  it("a throwing store never throws on read/write/clear", () => {
    expect(() => readHeadlessStamp(THROWING_STORE, "g")).not.toThrow();
    expect(readHeadlessStamp(THROWING_STORE, "g")).toBeNull();
    expect(() => writeHeadlessStamp(THROWING_STORE, "g", 123)).not.toThrow();
    expect(() => clearHeadlessStamp(THROWING_STORE, "g")).not.toThrow();
  });

  it("a non-finite or negative now is ignored (no write)", () => {
    const { store, map } = makeStore();
    writeHeadlessStamp(store, "g", Number.NaN);
    writeHeadlessStamp(store, "g", Number.POSITIVE_INFINITY);
    writeHeadlessStamp(store, "g", -1);
    expect(map.size).toBe(0);
  });
});

describe("headless-access-stamp — monotonic + clear", () => {
  it("never regresses to an older time (a racing stale apply cannot shorten the window)", () => {
    const { store } = makeStore();
    writeHeadlessStamp(store, "g", 2_000);
    writeHeadlessStamp(store, "g", 1_000); // older — ignored
    expect(readHeadlessStamp(store, "g")).toBe(2_000);
    writeHeadlessStamp(store, "g", 3_000); // newer — advances
    expect(readHeadlessStamp(store, "g")).toBe(3_000);
  });

  it("clear removes exactly this grant's stamp", () => {
    const { store } = makeStore();
    writeHeadlessStamp(store, "gKeep", 1_000);
    writeHeadlessStamp(store, "gDrop", 1_000);
    clearHeadlessStamp(store, "gDrop");
    expect(readHeadlessStamp(store, "gDrop")).toBeNull();
    expect(readHeadlessStamp(store, "gKeep")).toBe(1_000);
  });
});

describe("headless-access-stamp — drives the 7-day TTL exactly as the host will", () => {
  it("a fresh stamp keeps the grant within the idle TTL; a stale one expires it", () => {
    const { store } = makeStore();
    const grantedAt = 1_700_000_000_000;
    const now = grantedAt + HEADLESS_ACCESS_IDLE_TTL_MS + 1; // just past the window

    // No stamp yet → the host falls back to grantedAt, which is now stale.
    const stampOrGranted = readHeadlessStamp(store, "g") ?? grantedAt;
    expect(headlessAccessExpired(stampOrGranted, now)).toBe(true);

    // A recent apply stamps it fresh → no longer expired.
    writeHeadlessStamp(store, "g", now);
    const fresh = readHeadlessStamp(store, "g") ?? grantedAt;
    expect(headlessAccessExpired(fresh, now)).toBe(false);
  });
});
