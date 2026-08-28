/**
 * `AccountChip` (14-E) — the signed-in account affordance in the project
 * shell's actions pill. Follows the SharePopover pattern exactly: a ghost
 * pill button trigger, a `ui-popover` dialog, `useDismissable` for outside
 * click/Escape.
 *
 * Rendered ONLY when the auth gate published a user (auth-on deployments) —
 * auth-off runs carry no chip and the pill is byte-for-byte today's chrome.
 * "Sign out" POSTs /auth/logout (server drops the session + clears the
 * cookie), then reloads: the boot gate re-checks /auth/me and lands on the
 * sign-in screen.
 */
import { useCallback, useRef, useState } from "react";
import { signOut, type AuthUser } from "../auth-gate.js";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import "./auth-gate.css";

export function AccountChip({
  user,
  onOpenSettings,
}: {
  user: AuthUser;
  /** Open the device-scoped settings surface from the account menu. Optional. */
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((reason: DismissReason | "action") => {
    setOpen(false);
    if (reason === "escape") triggerRef.current?.focus();
  }, []);
  useDismissable(open, rootRef, close);

  const onSignOut = () => {
    setSigningOut(true);
    void signOut((input, init) => fetch(input, init)).then(() => {
      window.location.reload();
    });
  };

  // The avatar glyph: the display name's first character (uppercased).
  const initial = (user.display.codePointAt(0) !== undefined
    ? String.fromCodePoint(user.display.codePointAt(0)!)
    : "?"
  ).toUpperCase();

  return (
    <div className="account-chip-wrap" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="pill-btn account-chip"
        data-testid="account-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Signed in as ${user.display}`}
        aria-label={`Account: signed in as ${user.display}`}
        onClick={() => (open ? close("action") : setOpen(true))}
      >
        <span className="account-chip-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="account-chip-name">{user.display}</span>
      </button>
      {open && (
        <div
          className="ui-popover account-popover"
          role="dialog"
          aria-label="Account"
          data-testid="account-popover"
        >
          <p className="account-popover-identity">
            Signed in as <strong>{user.display}</strong>
          </p>
          {onOpenSettings && (
            <button
              type="button"
              className="account-action-btn"
              data-testid="account-settings"
              onClick={() => {
                close("action");
                onOpenSettings();
              }}
            >
              Settings
            </button>
          )}
          <button
            type="button"
            className="account-signout-btn"
            data-testid="auth-signout"
            disabled={signingOut}
            onClick={onSignOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
