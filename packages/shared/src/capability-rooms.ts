/**
 * Capability-room contracts (roadmap #1 slice 2, the Share/Agent-Access
 * authorization model under `GALLEY_SYNC_AUTH=required`).
 *
 * A CAPABILITY ROOM is a relay room whose id IS the access capability: the
 * browser mints an unguessable `share-<random>` id for a Share session or an
 * Agent Access control room. With sync auth OFF these rooms are pure bearer
 * capabilities (today's behavior, unchanged). With sync auth REQUIRED the relay
 * additionally requires the room to be REGISTERED by a signed-in user (a
 * cookie-authenticated `POST /auth/capability-rooms` on the web-server) and
 * still ACTIVE — so an operator can account for and revoke every live
 * capability, and an unregistered/revoked/expired link fails closed.
 *
 * This module is types + pure predicates only (the `@galley/shared` rule):
 * the durable registry adapter lives in `@galley/persistence`
 * (`FsCapabilityRoomRegistry`), the registration/revocation policy in
 * `@galley/auth`, the HTTP wiring in `apps/web-server`, and the upgrade gate in
 * `apps/sync`.
 */

/** The reserved relay-room namespace minted capabilities live under. */
export const CAPABILITY_ROOM_PREFIX = "share-";

/**
 * What a capability room is FOR:
 *  - `"share"`   — a live collaboration (Share) room. No default expiry: the
 *    sharer ends it with "Stop sharing" (revoke) or it simply stops being used.
 *  - `"control"` — an Agent Access control room (the MCP mailbox). Bounded to
 *    the registering session: it expires when that session expires.
 *
 * A B2 PAIRING room (ADR-0026) is a transient, code-derived bootstrap channel; it
 * is minted in the SAME `share-` namespace (so the relay's absent-Origin carve-out
 * + registration gate apply unchanged) and registered as a `"control"`-kind room
 * bounded to the registering session — it carries no durable authority and is torn
 * down on code-consume / 10-min TTL.
 */
export type CapabilityRoomKind = "share" | "control";

/** The set of known kinds, exported so validators never drift from the type. */
export const CAPABILITY_ROOM_KINDS: readonly CapabilityRoomKind[] = [
  "share",
  "control",
];

/**
 * One registry record, stored as
 * `$GALLEY_DATA_DIR/capability-rooms/<roomId>.json`. Revocation is a TOMBSTONE
 * (`revokedAtMs` set, file kept): a revoked roomId can never be re-registered,
 * so a leaked-then-revoked link cannot be resurrected by re-POSTing it.
 */
export interface CapabilityRoomRecord {
  version: 1;
  roomId: string;
  kind: CapabilityRoomKind;
  /** The session userId that registered the room (the only one who may revoke). */
  createdBy: string;
  createdAtMs: number;
  /** Absolute expiry. Control rooms: the registering session's expiry. Share rooms: none. */
  expiresAtMs?: number;
  /** Optional informational association (never used for authorization). */
  projectId?: string;
  /** Tombstone marker: set on revoke, never cleared. */
  revokedAtMs?: number;
  revokedBy?: string;
}

/**
 * The CAPABILITY-ROOM NAMESPACE validator — the single predicate every consumer
 * (registration route, registry filenames, the relay's upgrade gate, client
 * mint) uses, so the namespace can never drift between layers.
 *
 * Shape: `share-` + a bounded, URL- and FILESYSTEM-safe CSPRNG body of 16–64
 * chars from `[A-Za-z0-9_-]`. This covers both bodies `mintShareRoom` produces
 * (a UUID, 36 chars of hex+hyphens; or 32 hex chars) while excluding every
 * path-traversal ingredient: no `.`, no `/`, no `\`, no NUL, no `%` (so an
 * encoded traversal can't smuggle through either). The id doubles as the
 * registry FILENAME, so this predicate is the traversal gate — it MUST run
 * before any filesystem access.
 */
export function isCapabilityRoomId(value: unknown): value is string {
  return (
    typeof value === "string" && /^share-[A-Za-z0-9_-]{16,64}$/.test(value)
  );
}

/**
 * Whether a registry record is ACTIVE at `nowMs`: a structurally valid record
 * (valid id, known kind, sane timestamps — a malformed/garbage file on the
 * volume must never authorize anything), NOT revoked, and NOT expired. The one
 * shared definition the registration policy and the relay gate both use.
 */
export function isActiveCapabilityRoom(
  record: CapabilityRoomRecord,
  nowMs: number,
): boolean {
  if (record.version !== 1) return false;
  if (!isCapabilityRoomId(record.roomId)) return false;
  if (!CAPABILITY_ROOM_KINDS.includes(record.kind)) return false;
  if (typeof record.createdBy !== "string" || record.createdBy.length === 0)
    return false;
  if (
    typeof record.createdAtMs !== "number" ||
    !Number.isFinite(record.createdAtMs)
  )
    return false;
  if (record.revokedAtMs !== undefined) return false; // tombstone
  if (record.expiresAtMs !== undefined) {
    // A non-numeric expiry is malformed — fail closed, never "no expiry".
    if (
      typeof record.expiresAtMs !== "number" ||
      !Number.isFinite(record.expiresAtMs)
    )
      return false;
    if (record.expiresAtMs <= nowMs) return false;
  }
  return true;
}

/**
 * The durable registry seam (`@galley/persistence` implements it on the shared
 * data volume; tests use in-memory fakes). Implementations MUST validate every
 * externally-supplied roomId with {@link isCapabilityRoomId} before any storage
 * access (the id is an UNTRUSTED filename).
 */
export interface CapabilityRoomStore {
  /** The record for `roomId` (active or not), or null (invalid id / absent / unreadable). */
  get(roomId: string): Promise<CapabilityRoomRecord | null>;
  /** Create/replace the record. Throws on an invalid `record.roomId`. */
  put(record: CapabilityRoomRecord): Promise<void>;
  /** Every parseable record (malformed files are skipped, never returned). */
  list(): Promise<CapabilityRoomRecord[]>;
  /** Remove a record outright (registration-time GC only — revoke uses `put`). */
  remove(roomId: string): Promise<void>;
}
