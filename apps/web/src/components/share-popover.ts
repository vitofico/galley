/**
 * Pure helpers for the Share popover (#19.3, spec §2). No React, no DOM —
 * unit-tested in the node gate.
 */

import type { LinkStatus } from "../link-status.js";

/** The host-side progress phase of a freshly minted share room. */
export type ShareConnectPhase = "idle" | "connecting" | "unreachable";

/**
 * How long the host waits for its OWN socket's first handshake before telling
 * the user nobody answered. Mirrors the joiner-side join-sync timeout (the two
 * are the same wait: registration has already resolved by the time either runs,
 * so all that remains is the socket opening).
 */
export const SHARE_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Shown when {@link shareConnectPhase} reaches "unreachable". Deliberately
 * hedged: the client CANNOT distinguish a relay that is merely slow from one
 * that does not exist, so it reports what the user can observe ("not available
 * here") rather than asserting a cause, and the phase self-heals if a late
 * handshake still lands.
 */
export const SHARE_UNREACHABLE_MESSAGE =
  "Couldn't reach the sharing server — live collaboration isn't available here. Your work is saved on this device.";

/**
 * H8 + the host-side unreachable timeout: which state the Share popover should
 * present while a minted room's socket has yet to complete its first handshake.
 *
 *  - no connection                       → `idle`        (a plain local session shows no progress at all)
 *  - connected at least once             → `idle`        (linkStatus has left "initial" for good — show the link)
 *  - never connected, timer not yet fired → `connecting`  (calm "Connecting…", link withheld)
 *  - never connected, timer fired         → `unreachable` (go loud — see {@link SHARE_UNREACHABLE_MESSAGE})
 *
 * The `connecting` state used to be terminal, which is how a relay-less static
 * deploy (the GitHub Pages demo) produced a popover that span forever: the page
 * origin yields a syntactically VALID `wss://<host>:1234`, so URL validation
 * refuses nothing and no error path fires — the socket simply never opens and
 * `linkStatus` never leaves "initial". Nothing but a timer can observe that, so
 * `timedOut` is the third input.
 *
 * `linkStatus` is checked BEFORE `timedOut`, so a late-but-successful handshake
 * always wins over an already-fired timer (the phase is non-terminal and
 * self-heals, exactly like the joiner's `stalled` cue). Pure, so the Node gate
 * proves every transition without a live socket.
 */
export function shareConnectPhase(
  connectionPresent: boolean,
  linkStatus: LinkStatus,
  timedOut: boolean,
): ShareConnectPhase {
  if (!connectionPresent) return "idle";
  if (linkStatus !== "initial") return "idle";
  return timedOut ? "unreachable" : "connecting";
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
