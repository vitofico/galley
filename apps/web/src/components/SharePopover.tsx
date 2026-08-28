/**
 * `SharePopover` (#19.3, spec §2/§7) — the Share button plus its popover. The
 * always-visible share island below the pills goes away; its entire function
 * (the join-link UI) moves in here, joined by "who's in the room" (the
 * presence dots + count, moved out of the brand pill).
 *
 * Testid contract: `share-button` stays on the trigger; `share-bar`,
 * `share-link`, `copy-share-link` and `presence` keep living INSIDE the
 * popover, so the e2e suite's assertions only gain an "open the popover"
 * step where they previously read the island directly.
 *
 * Clicking Share (a) triggers the host's live-upgrade (`onShare` — idempotent;
 * a no-op when already shared) and (b) opens the popover. A joiner who booted
 * connected sees their own page URL as the link (see share-popover.ts).
 *
 * A11y: trigger has `aria-haspopup="dialog"`/`aria-expanded`; the popover is
 * a named non-modal dialog; Escape closes and refocuses the trigger; outside
 * pointerdown closes without stealing focus.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Presence } from "@galley/collab";
import { roomFromShareLink, type ShareRole } from "../share.js";
import {
  capabilityAuthActive,
  peekShareRegistration,
  revokeCapabilityRoomBestEffort,
  subscribeShareRegistrations,
} from "../capability-rooms-client.js";
import {
  displayedShareLink,
  peerDisplayName,
  peerRoleLabel,
  presenceSummary,
  type RosterPeer,
} from "./share-popover.js";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import { Notice } from "./Notice.js";
import "./rail-and-pills.css";

/** A peer's cursor color from its awareness `user` field (presence dots). */
function peerColor(presence: Presence): string {
  const user = (presence as { user?: { color?: string } }).user;
  return user?.color ?? "#9a9082";
}

export interface SharePopoverProps {
  /** Whether the session is live-connected to a sync room. */
  connected: boolean;
  /**
   * H8: the host has minted a room but its socket hasn't completed its first
   * handshake yet — present a "Connecting…" state instead of a copyable link
   * that points at a room nobody is serving. Absent/false → the historical
   * behavior (link shown as soon as it's minted). Host-only.
   */
  connecting?: boolean;
  /** The minted join link (sharer side), possibly relative. Null until minted. */
  shareLink: string | null;
  /** A share failure to surface (#19.4, spec §8) — shown as an error Notice. */
  error?: string | null;
  /** Live peers (incl. self) from the connection's awareness, each tagged with
   *  its clientID + an `isYou` flag (L7) so the local row reads "(you)". */
  peers: readonly RosterPeer<Presence>[];
  /**
   * C2: the link is reconnecting, so the roster is STALE (peers seen before the
   * drop may already be gone). Dims the presence list to signal "not live right
   * now" without ripping rows out mid-reconnect. Absent/false → normal.
   */
  stalePresence?: boolean;
  /** Whether the last copy attempt succeeded (host-owned, like the island era). */
  copied: boolean;
  /**
   * Copy the absolute link to the clipboard (host-owned handler). Resolves to
   * `false` when the copy failed (clipboard rejected / unavailable) so the
   * popover can fall back to focus+selecting the link for a manual ⌘C (M5).
   */
  onCopy: () => Promise<boolean> | void;
  /** The host's Share action: live-upgrade to a room (idempotent when shared). */
  onShare: () => void;
  /**
   * The host's Unshare action (B18): gracefully close the sync connection and
   * revert to local-only editing. Optional — absent (e.g. a joiner visiting
   * someone else's room) hides the Unshare button entirely.
   */
  onUnshare?: () => void;
  /**
   * The access level the NEXT-built share link grants (B19-sharing-roles).
   * Controlled by the host so the minted link + presence agree. Absent → the
   * role chooser is hidden (the historical editor-only Share UI).
   */
  role?: ShareRole;
  /** Change the access level for the link being built (B19-sharing-roles). */
  onRoleChange?: (role: ShareRole) => void;
  /**
   * The host's current display name (the local profile's, the name collaborators
   * see in the roster + on cursors). Absent/empty → collaborators see "Editor".
   */
  displayName?: string;
  /**
   * Commit a display name from inside the popover (host only). Wiring this prop
   * surfaces the "You appear as…" identity row — so a host names themselves at
   * the moment of sharing instead of leaving the generic "Editor" and only
   * finding the fix buried in Settings. Absent → the row is hidden (e.g. a joiner
   * visiting someone else's room, who was already prompted on the way in).
   */
  onSetDisplayName?: (name: string) => void;
}

export function SharePopover({
  connected,
  connecting,
  shareLink,
  error,
  peers,
  stalePresence,
  copied,
  onCopy,
  onShare,
  onUnshare,
  role,
  onRoleChange,
  displayName,
  onSetDisplayName,
}: SharePopoverProps) {
  const [open, setOpen] = useState(false);
  // The identity-row draft (host only). Seeded from the saved name; a ref tracks
  // the last seed so reopening the popover with an externally-changed name
  // refreshes the field without clobbering an in-progress edit.
  const [nameDraft, setNameDraft] = useState(displayName ?? "");
  const seededName = useRef(displayName ?? "");
  if (seededName.current !== (displayName ?? "")) {
    seededName.current = displayName ?? "";
    setNameDraft(displayName ?? "");
  }
  const [nameSaved, setNameSaved] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // M5: when a copy fails, focus the link input (its onFocus selects it) so the
  // user can ⌘C manually instead of getting no feedback at all.
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const handleCopy = useCallback(() => {
    void Promise.resolve(onCopy()).then((ok) => {
      if (ok === false) linkInputRef.current?.focus();
    });
  }, [onCopy]);

  // M7: a host who hasn't named themselves shares as the generic "Editor" — and
  // the identity row is easy to miss. When the popover opens for a host (the row
  // is present) with no name yet, focus the name field ONCE so they're nudged to
  // introduce themselves BEFORE handing out the link. Host-with-a-name keeps the
  // old behavior (no focus steal — the link is their next action). The once-per-
  // open guard means the user can freely click away (no focus trap) even though
  // `onSetDisplayName` isn't a stable reference.
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const autofocusedName = useRef(false);
  useEffect(() => {
    if (!open) {
      autofocusedName.current = false;
      return;
    }
    if (autofocusedName.current) return;
    if (onSetDisplayName && !(displayName ?? "").trim()) {
      autofocusedName.current = true;
      nameInputRef.current?.focus();
    }
  }, [open, onSetDisplayName, displayName]);

  const close = useCallback((reason: DismissReason | "action") => {
    setOpen(false);
    if (reason === "escape") triggerRef.current?.focus();
  }, []);
  useDismissable(open, rootRef, close);

  // #1 slice 2 — registration gate (auth-on deployments only). The HOST's
  // share upgrade registers the freshly minted room with the server before
  // connecting; this popover watches the SAME tracker and (a) holds the link
  // back while registration is pending, (b) surfaces a clean error when it
  // failed (cap hit / signed out / server unreachable). Untracked rooms — a
  // JOINER's popover, or any auth-off run, where the tracker is always
  // empty — render exactly as before.
  const [, setRegVersion] = useState(0);
  useEffect(() => subscribeShareRegistrations(() => setRegVersion((v) => v + 1)), []);
  const room = roomFromShareLink(shareLink);
  const registration = room !== null ? peekShareRegistration(room) : null;

  const link =
    typeof window === "undefined"
      ? shareLink
      : displayedShareLink(shareLink, connected, window.location.origin, window.location.href);

  return (
    <div className="share-popover-wrap" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="pill-btn"
        data-testid="share-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          connected
            ? "This project is shared — the join link and who's in the room"
            : "Share for live collaboration"
        }
        aria-label="Share for live collaboration"
        onClick={() => {
          if (open) {
            close("action");
            return;
          }
          onShare();
          setOpen(true);
        }}
      >
        {connected ? "Shared" : "Share"}
      </button>
      {open && (
        <div
          className="ui-popover share-popover"
          role="dialog"
          aria-label="Share"
          data-testid="share-popover"
        >
          {/* Identity first: name yourself BEFORE handing out the link, so
              collaborators never see the generic "Editor" in the roster / on your
              cursor. Host-only (joiners were already prompted on the way in). */}
          {onSetDisplayName && (
            <div className="share-identity" data-testid="share-identity">
              <label className="share-bar-label" htmlFor="share-display-name">
                You appear to collaborators as:
              </label>
              <div className="share-identity-row">
                <input
                  ref={nameInputRef}
                  id="share-display-name"
                  className="share-bar-link"
                  data-testid="share-display-name"
                  placeholder="Your name (otherwise “Editor”)"
                  value={nameDraft}
                  onChange={(e) => {
                    setNameDraft(e.target.value);
                    setNameSaved(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && nameDraft.trim()) {
                      onSetDisplayName(nameDraft.trim());
                      setNameSaved(true);
                    }
                  }}
                />
                <button
                  type="button"
                  data-testid="share-display-name-save"
                  disabled={!nameDraft.trim()}
                  onClick={() => {
                    onSetDisplayName(nameDraft.trim());
                    setNameSaved(true);
                  }}
                >
                  {nameSaved ? "Saved" : "Save"}
                </button>
              </div>
            </div>
          )}
          {error ? (
            <Notice severity="error" testId="share-error" message={error} />
          ) : registration?.status === "error" ? (
            <Notice severity="error" testId="share-error" message={registration.error} />
          ) : registration?.status === "pending" ? (
            <p className="share-popover-pending" role="status">
              Creating a share link…
            </p>
          ) : connecting ? (
            // H8: the room is minted but the socket hasn't opened — hold the
            // copyable link back until the first "connected" status, so a host
            // never sends a link to a room nobody is serving yet.
            <p
              className="share-popover-pending"
              role="status"
              data-testid="share-connecting"
            >
              Connecting… your share link will be ready in a moment.
            </p>
          ) : link ? (
            <div className="share-bar" data-testid="share-bar" role="status">
              {role && onRoleChange ? (
                <fieldset className="share-role" data-testid="share-role">
                  <legend className="share-bar-label">Anyone with this link can:</legend>
                  <label className="share-role-option">
                    <input
                      type="radio"
                      name="share-role"
                      value="editor"
                      data-testid="share-role-editor"
                      checked={role === "editor"}
                      onChange={() => onRoleChange("editor")}
                    />
                    <span>Edit</span>
                  </label>
                  <label className="share-role-option">
                    <input
                      type="radio"
                      name="share-role"
                      value="viewer"
                      data-testid="share-role-viewer"
                      checked={role === "viewer"}
                      onChange={() => onRoleChange("viewer")}
                    />
                    <span>View only</span>
                  </label>
                </fieldset>
              ) : (
                <span className="share-bar-label">Anyone with this link can edit:</span>
              )}
              <input
                ref={linkInputRef}
                className="share-bar-link"
                data-testid="share-link"
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" data-testid="copy-share-link" onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <p className="share-popover-pending" role="status">
              Creating a share link…
            </p>
          )}
          {connected && (
            <div
              className={`share-popover-room${stalePresence ? " share-popover-room--stale" : ""}`}
              {...(stalePresence ? { "data-stale": "true" } : {})}
            >
              <span className="share-popover-room-label">In the room</span>
              <span className="presence" data-testid="presence">
                {presenceSummary(peers)}
              </span>
              {peers.length > 0 && (
                <ul className="share-peer-list" data-testid="share-peers">
                  {peers.map((p, i) => (
                    <li key={i} className="share-peer">
                      <span
                        className="presence-dot"
                        style={{ background: peerColor(p) }}
                        aria-hidden="true"
                      />
                      <span className="share-peer-name">{peerDisplayName(p)}</span>
                      {p.isYou && (
                        <span className="share-peer-you" data-testid="share-peer-you">
                          (you)
                        </span>
                      )}
                      {peerRoleLabel(p) && (
                        <span className="share-peer-role">{peerRoleLabel(p)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {/* B18 — stop sharing: close the live connection and revert to
                  local-only editing. Hidden when the host gives no handler (a
                  joiner visiting someone else's room can't unshare it). */}
              {onUnshare && (
                <button
                  type="button"
                  className="share-unshare"
                  data-testid="unshare-button"
                  onClick={() => {
                    // M6: stop-sharing is destructive and one-way — it drops
                    // every peer and the next Share mints a NEW link (this one
                    // dies). Confirm first (same `window.confirm` guard the
                    // template-switch replace uses) so a stray click can't end a
                    // live session.
                    const ok = window.confirm(
                      "Stop sharing this project?\n\n" +
                        "The live session ends and this link stops working for everyone in " +
                        "the room. You can share again later, but it creates a new link.",
                    );
                    if (!ok) return;
                    // #1 slice 2: under auth, "Stop sharing" also REVOKES the
                    // room's registration server-side — best-effort and never
                    // awaited: the local teardown below proceeds regardless.
                    // The tombstone denies FUTURE joins/reconnects; peers
                    // already in the room drain when they disconnect. Only the
                    // host reaches this button (no handler → no button), and
                    // with auth off no call is made at all.
                    if (capabilityAuthActive() && room !== null) {
                      void revokeCapabilityRoomBestEffort(room);
                    }
                    onUnshare();
                    close("action");
                  }}
                >
                  Stop sharing
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
