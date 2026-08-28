/**
 * Capability-room registration/revocation POLICY (#1 slice 2) — the
 * framework-agnostic core behind `POST /auth/capability-rooms` and
 * `POST /auth/capability-rooms/:roomId/revoke` (the Hono wiring lives in
 * `apps/web-server/src/auth-router.ts`, like the rest of the OIDC router).
 *
 * Inputs arrive PRE-AUTHENTICATED: the router has already resolved a valid
 * session (userId + its expiry) and enforced the same-origin check; this module
 * owns everything else — body validation, the reserved-namespace gate,
 * idempotency, tombstoned revocation (no resurrection within the 512-deep
 * per-user retention window — see TOMBSTONE_CAP_PER_USER), per-user caps, and
 * the registration-time GC of expired control records.
 *
 * CONCURRENCY (security-round HIGH-2/M4): the cap check is read-count-then-write
 * against shared registry state, so registration is SERIALIZED PER USER with an
 * in-process keyed mutex — concurrent POSTs for distinct roomIds by one user
 * cannot all pass the cap. Every registry WRITE (register put, revoke put, GC
 * remove) additionally holds that ROOM's lock, and GC re-reads each candidate
 * under it before removing — a concurrently re-registered (now ACTIVE) record
 * can never be swept. In-process locking suffices because exactly ONE
 * web-server process mounts these routes and owns registry writes (the sync
 * relay only READS); a multi-writer web deployment would need file locks.
 *
 * Error DISCIPLINE: every failure is a constant `{ ok: false, code }` shape —
 * no roomIds, userIds, paths, or store internals are ever echoed, and revoke
 * answers identically for "no such room" and "not yours" (no ownership oracle).
 */
import {
  isActiveCapabilityRoom,
  isCapabilityRoomId,
  type CapabilityRoomKind,
  type CapabilityRoomRecord,
  type CapabilityRoomStore,
} from "@galley/shared";

/** Max ACTIVE capability rooms (share + control) one user may hold. */
export const MAX_ACTIVE_CAPABILITY_ROOMS_PER_USER = 128;
/** Max ACTIVE control rooms one user may hold (a user runs few agent sessions). */
export const MAX_ACTIVE_CONTROL_ROOMS_PER_USER = 8;
/**
 * Max revocation TOMBSTONES retained per user, FIFO-pruned on revoke
 * (verification round, M: unbounded permanent tombstones). Tombstones must
 * persist (they are the no-resurrection guarantee) but cannot be allowed to
 * grow without bound: an authenticated register→revoke loop with fresh ids
 * would otherwise mint unlimited tiny files on the shared data volume — a
 * disk-exhaustion vector limited only by request rate. The trade-off of
 * pruning the OLDEST beyond 512: resurrection re-opens ONLY for that exact
 * pruned id, ONLY via an authenticated user deliberately re-registering it —
 * the most recent 512 revocations stay absolutely protected, and disk is
 * bounded at ~512 tiny JSON files per user.
 */
export const TOMBSTONE_CAP_PER_USER = 512;

/**
 * Per-key in-process serialization (a local copy of the persistence
 * `KeyedMutex` — `@galley/auth` cannot depend on `@galley/persistence`).
 * `run` chains ops per key so each runs to completion before the next starts.
 */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(op, op); // run regardless of the previous op's outcome
    // Install a never-rejecting tail so a failed op can't poison the chain.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    // Drop the entry once this tail settles AND it's still the installed one, so
    // the map doesn't grow unbounded across many distinct keys.
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }
}

/**
 * One mutex per registry store (WeakMap so a dropped store frees its locks).
 * Keys are namespaced (`user:` / `room:`) and the ONLY nesting order is
 * user → room (register holds its user lock while taking room locks; nothing
 * ever takes a user lock while holding a room lock), so no deadlock is possible.
 */
const storeLocks = new WeakMap<CapabilityRoomStore, KeyedMutex>();
function locksFor(store: CapabilityRoomStore): KeyedMutex {
  let locks = storeLocks.get(store);
  if (locks === undefined) {
    locks = new KeyedMutex();
    storeLocks.set(store, locks);
  }
  return locks;
}

/** The constant-shape route result the HTTP layer serializes verbatim. */
export type CapabilityRoomRouteResult =
  | { status: 200; body: { ok: true } }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 413;
      body: { ok: false; code: CapabilityRoomErrorCode };
    };

export type CapabilityRoomErrorCode =
  | "invalid" // malformed body / id / kind / projectId
  | "unauthenticated" // no valid session (set by the router)
  | "forbidden" // origin mismatch (router), conflict, or revoked-id resurrection
  | "unknown" // revoke: no such room OR not the creator (identical on purpose)
  | "cap-exceeded" // per-user active-room cap hit
  | "too-large"; // oversized body (set by the router)

const ok = (): CapabilityRoomRouteResult => ({
  status: 200,
  body: { ok: true },
});
const fail = (
  status: 400 | 401 | 403 | 404 | 409 | 413,
  code: CapabilityRoomErrorCode,
): CapabilityRoomRouteResult => ({ status, body: { ok: false, code } });

export interface RegisterCapabilityRoomInput {
  /** The parsed JSON request body (UNTRUSTED — validated here). */
  body: unknown;
  /** The authenticated session's userId (becomes `createdBy`). */
  userId: string;
  /** The authenticated session's absolute expiry — a control room's expiry. */
  sessionExpiresAtMs: number;
  nowMs: number;
}

/** Validated registration request, or null (one constant `invalid` for all faults). */
function parseRegisterBody(
  body: unknown,
): { roomId: string; kind: CapabilityRoomKind; projectId?: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const { roomId, kind, projectId } = body as Record<string, unknown>;
  if (!isCapabilityRoomId(roomId)) return null;
  if (kind !== "share" && kind !== "control") return null;
  if (projectId !== undefined) {
    if (
      typeof projectId !== "string" ||
      projectId.length === 0 ||
      projectId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(projectId)
    ) {
      return null;
    }
    return { roomId, kind, projectId };
  }
  return { roomId, kind };
}

/**
 * Registration-time GC (the design's only sweep — no background timer): drop
 * EXPIRED control records (their session is gone; the file is dead weight).
 * Revocation TOMBSTONES are deliberately NOT collected here: a tombstone is
 * the only thing standing between a revoked roomId and its re-registration.
 * Their growth is bounded on the REVOKE side instead — a per-user FIFO cap
 * ({@link TOMBSTONE_CAP_PER_USER}, see pruneTombstones) so a register→revoke
 * loop cannot exhaust the shared volume.
 *
 * RACE SAFETY (M4): `list()` is a snapshot; a candidate may have been
 * re-registered (fresh, ACTIVE) between the snapshot and the remove. Each
 * candidate is therefore RE-READ under its room lock and removed only if it is
 * STILL an expired control record. Errors are swallowed per entry — GC is
 * housekeeping and must never block a registration.
 */
async function gcCapabilityRooms(
  store: CapabilityRoomStore,
  locks: KeyedMutex,
  nowMs: number,
): Promise<void> {
  let all: CapabilityRoomRecord[];
  try {
    all = await store.list();
  } catch {
    return; // housekeeping only — a listing failure must not block registration
  }
  for (const candidate of all) {
    if (candidate.revokedAtMs !== undefined) continue; // tombstones live forever
    if (
      candidate.kind !== "control" ||
      typeof candidate.expiresAtMs !== "number" ||
      !(candidate.expiresAtMs <= nowMs)
    ) {
      continue; // not an expired control record (NaN/garbage expiry → leave it)
    }
    try {
      await locks.run(`room:${candidate.roomId}`, async () => {
        // Re-read under the room lock (M4): only remove what is STILL an
        // expired, unrevoked control record — never a record that a concurrent
        // registration just refreshed (active) or a revoke just tombstoned.
        const current = await store.get(candidate.roomId);
        if (
          current !== null &&
          current.revokedAtMs === undefined &&
          current.kind === "control" &&
          typeof current.expiresAtMs === "number" &&
          current.expiresAtMs <= nowMs
        ) {
          await store.remove(candidate.roomId);
        }
      });
    } catch {
      // skip this entry; GC is best-effort
    }
  }
}

/**
 * Register (or idempotently re-affirm) a capability room. Decision order:
 *
 *   1. Validate the body (namespace-gated roomId, known kind, bounded projectId).
 *   2. Serialize on the USER lock (HIGH-2: the cap check below is
 *      count-then-write; without per-user serialization N concurrent POSTs for
 *      distinct roomIds at cap-1 would ALL pass the count and over-shoot).
 *   3. GC expired control records (tombstones are never collected).
 *   4. Under the ROOM lock: a REVOKED roomId can never come back — tombstones
 *      reject resurrection. An ACTIVE record is idempotent for the SAME
 *      createdBy+kind (re-POST → ok, no rewrite); anyone/anything else →
 *      constant `forbidden`. An EXPIRED (non-revoked) record may be
 *      re-registered by its ORIGINAL creator only.
 *   5. Caps: ≤128 active rooms/user, ≤8 active control rooms/user.
 *   6. Write: control rooms expire AT THE SESSION'S EXPIRY; share rooms carry
 *      no default expiry (revocation/abandonment ends them).
 */
export async function registerCapabilityRoom(
  store: CapabilityRoomStore,
  input: RegisterCapabilityRoomInput,
): Promise<CapabilityRoomRouteResult> {
  const parsed = parseRegisterBody(input.body);
  if (parsed === null) return fail(400, "invalid");
  const { roomId, kind, projectId } = parsed;
  const locks = locksFor(store);

  // HIGH-2: the whole GC + existence-check + cap-count + write sequence runs
  // under this user's lock, so one user's registrations are strictly serial.
  // (In-process is sufficient: one web-server process owns registry writes.)
  return locks.run(`user:${input.userId}`, async () => {
    await gcCapabilityRooms(store, locks, input.nowMs);

    // The room lock pairs every read-decide-write on ONE record (register vs
    // revoke vs GC re-read) so no interleaving can resurrect or double-write.
    return locks.run(`room:${roomId}`, async () => {
      const existing = await store.get(roomId);
      if (existing !== null) {
        if (existing.revokedAtMs !== undefined) return fail(403, "forbidden"); // no resurrection
        if (isActiveCapabilityRoom(existing, input.nowMs)) {
          if (existing.createdBy === input.userId && existing.kind === kind)
            return ok(); // idempotent
          return fail(403, "forbidden");
        }
        // Expired (or malformed-inactive) and not revoked: only the original
        // creator may claim the id again — a fresh record is written below.
        if (existing.createdBy !== input.userId) return fail(403, "forbidden");
      }

      const mine = (await store.list()).filter(
        (r) =>
          r.createdBy === input.userId && isActiveCapabilityRoom(r, input.nowMs),
      );
      if (mine.length >= MAX_ACTIVE_CAPABILITY_ROOMS_PER_USER)
        return fail(409, "cap-exceeded");
      if (
        kind === "control" &&
        mine.filter((r) => r.kind === "control").length >=
          MAX_ACTIVE_CONTROL_ROOMS_PER_USER
      ) {
        return fail(409, "cap-exceeded");
      }

      const record: CapabilityRoomRecord = {
        version: 1,
        roomId,
        kind,
        createdBy: input.userId,
        createdAtMs: input.nowMs,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(kind === "control"
          ? { expiresAtMs: input.sessionExpiresAtMs }
          : {}),
      };
      await store.put(record);
      return ok();
    });
  });
}

export interface RevokeCapabilityRoomInput {
  /** The roomId from the URL param (UNTRUSTED). */
  roomId: string;
  /** The authenticated session's userId — only the creator may revoke. */
  userId: string;
  nowMs: number;
}

/**
 * Revoke a capability room: write the TOMBSTONE (the record stays — FOREVER;
 * tombstones are excluded from GC, so a revoked roomId can never be
 * re-registered). Only the creator may revoke; an unknown room and a room
 * someone else created answer IDENTICALLY (`404 unknown`) so revoke can't be
 * used as an existence/ownership oracle. Revoking an already-revoked own room
 * is idempotent (`ok`). Revocation denies FUTURE joins/reconnects at the
 * relay; connections already inside the room persist until they disconnect
 * (there is no live-kick channel — documented in docs/security-model.md).
 *
 * The whole flow runs under the USER lock (the same one registration holds —
 * the tombstone-cap prune below is a count-then-delete that must not race a
 * concurrent revoke by the same user), and the get→put on the record itself
 * under the ROOM lock (user→room, the one nesting order — no deadlock), so it
 * cannot interleave with a concurrent registration or GC sweep of the same
 * record.
 */
export async function revokeCapabilityRoom(
  store: CapabilityRoomStore,
  input: RevokeCapabilityRoomInput,
): Promise<CapabilityRoomRouteResult> {
  if (!isCapabilityRoomId(input.roomId)) return fail(404, "unknown");
  const locks = locksFor(store);
  return locks.run(`user:${input.userId}`, async () => {
    const result = await locks.run(`room:${input.roomId}`, async () => {
      const existing = await store.get(input.roomId);
      if (existing === null || existing.createdBy !== input.userId)
        return fail(404, "unknown");
      if (existing.revokedAtMs !== undefined) return ok(); // already a tombstone
      await store.put({
        ...existing,
        revokedAtMs: input.nowMs,
        revokedBy: input.userId,
      });
      return ok();
    });
    // A NEW tombstone may have pushed this user over the retention cap —
    // FIFO-prune their oldest. (Only a fresh write can grow the count, but the
    // prune is idempotent housekeeping; running it after an idempotent re-
    // revoke would simply find nothing to do.)
    if (result.status === 200) await pruneTombstones(store, locks, input.userId);
    return result;
  });
}

/**
 * Keep at most {@link TOMBSTONE_CAP_PER_USER} tombstones per user, deleting
 * the OLDEST (by `revokedAtMs`, roomId tie-break) beyond the cap. Runs under
 * the caller's USER lock; each deletion re-reads its record under the ROOM
 * lock and only removes what is STILL this user's tombstone (the same M4
 * discipline as the GC sweep). Best-effort: a prune failure never fails the
 * revoke that triggered it.
 */
async function pruneTombstones(
  store: CapabilityRoomStore,
  locks: KeyedMutex,
  userId: string,
): Promise<void> {
  let mine: CapabilityRoomRecord[];
  try {
    mine = (await store.list()).filter(
      (r) => r.createdBy === userId && r.revokedAtMs !== undefined,
    );
  } catch {
    return; // housekeeping only
  }
  if (mine.length <= TOMBSTONE_CAP_PER_USER) return;
  const oldestFirst = [...mine].sort((a, b) => {
    const at = typeof a.revokedAtMs === "number" ? a.revokedAtMs : 0;
    const bt = typeof b.revokedAtMs === "number" ? b.revokedAtMs : 0;
    return at !== bt ? at - bt : a.roomId < b.roomId ? -1 : 1;
  });
  const victims = oldestFirst.slice(0, mine.length - TOMBSTONE_CAP_PER_USER);
  for (const victim of victims) {
    try {
      await locks.run(`room:${victim.roomId}`, async () => {
        const current = await store.get(victim.roomId);
        if (
          current !== null &&
          current.createdBy === userId &&
          current.revokedAtMs !== undefined
        ) {
          await store.remove(victim.roomId);
        }
      });
    } catch {
      // skip this victim; best-effort
    }
  }
}
