/**
 * 14-E auth activation — the SPA-side boot-gate logic, kept PURE of React
 * (mirrors the provider-storage.ts seam style: zero side effects at import
 * time, injectable I/O so the Node unit gate exercises everything offline).
 * The React shell around it lives in `components/AuthGate.tsx`.
 *
 * THE ONE RULE: the gate never PROBES for auth. When the deployment is
 * auth-off, `/auth/me` is not mounted and falls through to the SPA wildcard —
 * answering index.html 200 — so any probe would mis-detect. The server tells
 * the SPA instead: the runtime config (`window.__GALLEY_CONFIG__`, the same
 * serve-time seam the compile URL uses) carries `auth: true` exactly when the
 * auth router is mounted. No flag → the gate code never mounts and boot is
 * byte-for-byte the no-auth behavior.
 */

/** The signed-in identity the gate exposes to the shells. */
export interface AuthUser {
  /** The opaque stable user id (`oidc:…`) — the authorization identity. */
  userId: string;
  /** What to SHOW: the IdP's name/email when sent, else the userId. */
  display: string;
}

export type AuthState =
  | { kind: "authenticated"; user: AuthUser }
  | { kind: "unauthenticated" };

/** The minimal fetch surface the gate uses — trivially fakeable in unit tests. */
export type AuthFetch = (
  input: string,
  init?: {
    method?: string;
    credentials?: "same-origin";
    cache?: "no-store";
    headers?: Record<string, string>;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Whether the server-rendered runtime config says auth is on. DEFENSIVE and
 * strict: only a literal `auth: true` in the expected slot counts — anything
 * else (absent global, wrong type, truthy non-boolean) is auth-off, the safe
 * default that leaves boot untouched.
 */
export function isAuthEnabled(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  return (config as { auth?: unknown }).auth === true;
}

/**
 * Ask the server who we are (GET /auth/me, same-origin cookie included).
 * Anything that isn't a well-shaped authenticated answer — 401, a network
 * error, malformed JSON, a missing userId — resolves to `unauthenticated`:
 * the gate fails CLOSED to the sign-in screen (signing in again is always
 * safe; rendering the app without a session is not).
 *
 * `cache: "no-store"` because this answer is the boot AUTHORITY: a cached
 * `authenticated: true` could render the app after logout/expiry or mask a
 * network failure. The server marks /auth/me no-store too — this is the
 * client half of the same guarantee (and covers any intermediary the server
 * header didn't reach).
 */
export async function fetchAuthState(fetchImpl: AuthFetch): Promise<AuthState> {
  try {
    const res = await fetchImpl("/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { kind: "unauthenticated" };
    const body = (await res.json()) as { authenticated?: unknown; userId?: unknown; display?: unknown };
    if (body === null || typeof body !== "object") return { kind: "unauthenticated" };
    if (body.authenticated !== true || typeof body.userId !== "string" || body.userId === "") {
      return { kind: "unauthenticated" };
    }
    const display =
      typeof body.display === "string" && body.display.trim() !== "" ? body.display : body.userId;
    return { kind: "authenticated", user: { userId: body.userId, display } };
  } catch {
    return { kind: "unauthenticated" };
  }
}

/**
 * The /auth/login URL carrying the current location as `returnTo`, so the
 * round-trip through the IdP lands the user back on the page they asked for.
 * Defensive client-side mirror of the server's `safeReturnTo` (same-origin
 * absolute path only); the server re-validates regardless.
 */
export function signInUrl(path: string, search: string): string {
  const candidate = `${path}${search}`;
  const returnTo =
    candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * End the session (POST /auth/logout — the server drops the session AND clears
 * the cookie). Never throws: even a failed call should let the caller reload
 * into the gate, where /auth/me decides the truth.
 */
export async function signOut(fetchImpl: AuthFetch): Promise<void> {
  try {
    await fetchImpl("/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // Offline / server gone — the reload lands on the gate either way.
  }
}

/**
 * The module-level signed-in user, set ONCE by the gate before the app renders
 * (the gate mounts strictly before any shell). Shells read it at render time
 * to show the account chip — null in every auth-off run, so they render
 * byte-for-byte today's chrome.
 */
let activeAuthUser: AuthUser | null = null;

export function setActiveAuthUser(user: AuthUser | null): void {
  activeAuthUser = user;
}

export function getActiveAuthUser(): AuthUser | null {
  return activeAuthUser;
}
