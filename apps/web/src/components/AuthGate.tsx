/**
 * `AuthGate` (14-E) — the boot-time auth gate. Mounted by `main.tsx` ONLY when
 * the server-rendered runtime config says auth is on (`isAuthEnabled`); in
 * every other run this module's code never mounts and boot is byte-for-byte
 * the no-auth behavior.
 *
 * Three states, all decided by ONE `/auth/me` round-trip (the pure logic lives
 * in `auth-gate.ts`):
 *   - checking      → a quiet full-bleed paper surface (no flash: it is the
 *                     same color the body already paints);
 *   - unauthenticated → the full-screen sign-in card (below) — `/auth/login`
 *                     with the current location as `returnTo`;
 *   - authenticated → the app renders normally; the user is published via
 *                     `setActiveAuthUser` BEFORE the children mount so the
 *                     shells can show the account chip.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  fetchAuthState,
  setActiveAuthUser,
  signInUrl,
  type AuthState,
} from "../auth-gate.js";
import "./auth-gate.css";

/** The polished first-impression screen: brand, one line, one action. */
function SignInScreen() {
  return (
    <div className="auth-shell" data-testid="auth-signin">
      <main className="auth-card" aria-labelledby="auth-card-title">
        <span className="brand auth-card-brand" id="auth-card-title">
          <span className="brand-word">Galley</span>
        </span>
        <p className="auth-card-tagline">
          The AI-native document workspace, built on Typst.
        </p>
        <button
          type="button"
          className="auth-signin-btn"
          data-testid="auth-signin-button"
          onClick={() =>
            window.location.assign(
              signInUrl(window.location.pathname, window.location.search),
            )
          }
        >
          Sign in
        </button>
        <p className="auth-card-hint">
          You’ll continue to your organization’s sign-in page and come right
          back to your work.
        </p>
      </main>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    let alive = true; // StrictMode double-mount: only the live effect commits
    void fetchAuthState((input, init) => fetch(input, init)).then((next) => {
      if (!alive) return;
      setActiveAuthUser(next.kind === "authenticated" ? next.user : null);
      setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (state === null) {
    // Minimal, non-flashing: the same paper the body already paints, with an
    // accessible busy announcement and nothing visual to flash.
    return (
      <div
        className="auth-gate-checking"
        data-testid="auth-checking"
        role="status"
        aria-busy="true"
        aria-label="Checking your session"
      />
    );
  }
  if (state.kind === "unauthenticated") return <SignInScreen />;
  return <>{children}</>;
}
