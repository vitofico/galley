/**
 * Pure helpers for the Share popover (#19.3, spec §2). No React, no DOM —
 * unit-tested in the node gate.
 */

import type { LinkStatus } from "../link-status.js";

/**
 * H8: the host has live-upgraded to a room (a connection object exists) but its
 * socket hasn't completed its first handshake yet — `linkStatus` is still
 * "initial", which the C2 reducer leaves untouched until the first "connected"
 * status. Until then the minted join link points at a room nobody is serving, so
 * the popover should present a calm "Connecting…" state, NOT a copyable link.
 *
 * Once the first "connected" lands, `linkStatus` advances to "online" (and never
 * returns to "initial" — a later drop is "reconnecting"), so this is true ONLY
 * for the pre-first-connect window. Host-only at the call site (a joiner boots
 * into an existing room; the auth-on registration-pending path is handled
 * separately). Pure so the Node gate proves the gate without a live socket.
 */
export function isShareConnecting(
  connectionPresent: boolean,
  linkStatus: LinkStatus,
): boolean {
  return connectionPresent && linkStatus === "initial";
}

/**
 * The join link the popover should display.
 *
 * - The sharer has a minted `shareLink` (possibly relative) — resolve it
 *   against the page origin so the copied link works anywhere.
 * - A JOINER's session booted connected without minting one: their own page
 *   URL (`href`) IS the share link — show that, so "who else can I invite?"
 *   has an answer on both sides of the room.
 * - Not connected and nothing minted → null (the popover shows the explainer).
 */
export function displayedShareLink(
  shareLink: string | null,
  connected: boolean,
  origin: string,
  href: string,
): string | null {
  if (shareLink) {
    try {
      return new URL(shareLink, origin).toString();
    } catch {
      return shareLink;
    }
  }
  return connected ? href : null;
}

/** A roster row: the peer's presence plus its awareness `clientID` and whether
 *  it is the LOCAL client (so the UI can mark it "(you)"). */
export type RosterPeer<P> = P & { clientID: number; isYou: boolean };

/**
 * L7: annotate each awareness roster entry with its `clientID` and an `isYou`
 * flag — true for the row whose clientID matches the local connection's. Two
 * browser tabs of the same user are two DISTINCT awareness clients (two cursors),
 * so the roster legitimately shows two rows; without a marker the user can't tell
 * which "Editor" is them. We MARK the local row rather than merge genuinely
 * distinct sessions. A `null` local id (no live awareness) marks nothing. Pure
 * (the clientID match is the whole logic), so it unit-tests without a socket.
 */
export function buildPresenceRoster<P extends object>(
  entries: readonly (readonly [number, P])[],
  localClientID: number | null,
): RosterPeer<P>[] {
  return entries.map(([clientID, presence]) => ({
    ...presence,
    clientID,
    isYou: localClientID !== null && clientID === localClientID,
  }));
}

/**
 * The presence summary line for the room roster. Counts editors vs viewers from
 * the peers' roles (matching `peerRoleLabel`) so it never claims "N editor(s)"
 * while the roster badges viewers right below. With no viewers it renders the
 * historical "N editor(s)" byte-for-byte (the topbar-era wording the e2e matches).
 */
export function presenceSummary(
  peers: readonly ({ role?: unknown } & Record<string, unknown>)[],
): string {
  const viewers = peers.filter((p) => p.role === "viewer").length;
  const editors = peers.length - viewers;
  if (viewers === 0) return `${editors} editor(s)`;
  if (editors === 0) return `${viewers} viewer(s)`;
  return `${editors} editor(s) · ${viewers} viewer(s)`;
}

/**
 * A peer's display name for the "who's in the room" list (#19.4, spec §7).
 * Prefers the presence `user.name` (which carries the real display name once a
 * joiner answered the name prompt — `authorLabel` feeds it); falls back to the
 * author's own optional name, then the generic labels. Pure over the awareness
 * state shape, so it unit-tests without a connection.
 */
export function peerDisplayName(
  presence: { author?: { kind: string; name?: string } } & Record<string, unknown>,
): string {
  // The presence `user` field is editor-owned (opaque on the Presence type) —
  // narrow it safely rather than trusting the shape.
  const user = presence["user"] as { name?: unknown } | undefined;
  const fromUser = typeof user?.name === "string" ? user.name.trim() : "";
  if (fromUser) return fromUser;
  const author = presence.author;
  if (author?.kind === "agent") return "Agent";
  const fromAuthor = author?.name?.trim();
  return fromAuthor ? fromAuthor : "Editor";
}

/**
 * The access-level badge for a peer in the room roster (B19-sharing-roles).
 * Reads the optional `role` carried on presence; a `viewer` shows "Viewer", and
 * anything else (an explicit `editor`, an agent, or a pre-role peer with no
 * role) shows nothing — the absence of a badge IS the editor case, so the
 * historical roster (every peer an editor) renders byte-for-byte unchanged.
 */
export function peerRoleLabel(
  presence: { role?: unknown } & Record<string, unknown>,
): string | null {
  return presence.role === "viewer" ? "Viewer" : null;
}
