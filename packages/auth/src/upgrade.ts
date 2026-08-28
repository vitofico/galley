/**
 * Authorize a collaboration sync ws upgrade (roadmap #4 slice 5, ADR-0018 §4):
 * resolve the session from the request cookie, map the room to its project, and
 * check membership via the injected `Authorizer`. Fails closed (no/invalid
 * session, unknown room, non-member → false). Framework-agnostic — the sync
 * server calls this at the upgrade and closes denied connections.
 */
import type { Authorizer, CapabilityRoomStore, SessionStore } from "@galley/shared";
import { isActiveCapabilityRoom, isCapabilityRoomId, projectIdFromSyncRoom } from "@galley/shared";

/** Read one cookie value from a `Cookie` header, or null. */
export function parseCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface AuthorizeSyncUpgradeOptions {
  cookieHeader: string | undefined | null;
  room: string;
  sessionStore: SessionStore;
  authorizer: Authorizer;
  nowMs: number;
  /** Cookie name (default matches the auth router's `__Host-galley.sid`). */
  cookieName?: string;
}

export async function authorizeSyncUpgrade(opts: AuthorizeSyncUpgradeOptions): Promise<boolean> {
  const id = parseCookie(opts.cookieHeader, opts.cookieName ?? "__Host-galley.sid");
  if (!id) return false;
  const session = await opts.sessionStore.getValid(id, opts.nowMs);
  if (!session) return false;
  return opts.authorizer.canAccessProject(session.userId, projectIdFromSyncRoom(opts.room));
}

/**
 * Authorize a CAPABILITY-ROOM ws upgrade (#1 slice 2): a room in the reserved
 * `share-…` namespace is admitted iff the registry holds an ACTIVE record for
 * it — registered by a signed-in user, not revoked, not expired. NO cookie is
 * consulted: the joiner side of a share link and the cookie-less Node MCP
 * kernel both hold only the room capability. A non-namespace room, a registry
 * miss, a tombstone, an expired control record, and a registry ERROR all fail
 * closed (false). Authorization happens at the upgrade only — never per
 * message — so revocation denies future joins/reconnects while connections
 * already inside a room persist until they disconnect.
 */
export async function authorizeCapabilityRoomUpgrade(opts: {
  room: string;
  registry: CapabilityRoomStore;
  nowMs: number;
}): Promise<boolean> {
  if (!isCapabilityRoomId(opts.room)) return false;
  try {
    const record = await opts.registry.get(opts.room);
    return record !== null && isActiveCapabilityRoom(record, opts.nowMs);
  } catch {
    return false; // registry failure → deny, never an open door
  }
}
