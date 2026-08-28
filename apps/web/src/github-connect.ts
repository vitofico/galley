/**
 * Connect GitHub — device-scoped PAT + resolved login behind an injectable
 * storage seam.
 *
 * Mirrors the established client-side secret pattern (`provider-storage.ts`,
 * `git-remote-config.ts`): one namespaced localStorage key, zero side effects
 * at import time, guarded best-effort storage access, and an injectable store
 * so the Node unit gate exercises it with a plain Map-backed fake.
 *
 * ## Scope split (2026-06-15 IA/placement follow-up)
 *  - This connection is DEVICE-scoped: the credential (token) and the identity
 *    it resolves to (login) are shared across every project in this browser.
 *  - The PUSH TARGET (owner/name/branch) is PER-PROJECT and lives in
 *    `github-repo-target.ts`, so each project remembers its own repository
 *    instead of inheriting one device-wide selection.
 *
 * ## Security posture
 *  - The PAT lives in THIS browser's localStorage only — never sent to any
 *    Galley server; all GitHub egress goes browser → `api.github.com` directly
 *    (see `github-api.ts`).
 *  - UI code renders from {@link RedactedGithubConnection} (login + `hasToken`),
 *    which structurally CANNOT carry the token — same write-only discipline as
 *    the git-remote panel.
 *  - This module never logs, throws, or stringifies the token.
 */

/** The localStorage key holding the single (per-browser) GitHub connection. */
export const GITHUB_CONNECT_KEY = "galley.githubConnect";

/** The stored connection: the device-scoped PAT and who it resolved to. */
export interface GithubConnection {
  token: string;
  login: string;
}

/** What UI may render: structurally token-free. */
export interface RedactedGithubConnection {
  login: string;
  hasToken: true;
}

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface GithubConnectStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolve the guarded default storage (real `localStorage`, else null). */
function defaultStorage(): GithubConnectStorage | null {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Accessing localStorage can throw (e.g. blocked by the browser).
  }
  return null;
}

/**
 * Coerce parsed JSON into a valid {@link GithubConnection}, or null. Any legacy
 * `repo` field (from before the per-project split) is simply ignored — the
 * token/login still load; the push target now lives in `github-repo-target`.
 */
function normalize(raw: unknown): GithubConnection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.token !== "string" || obj.token.length === 0) return null;
  if (typeof obj.login !== "string" || obj.login.length === 0) return null;
  return { token: obj.token, login: obj.login };
}

/**
 * Load the FULL stored connection (including the token) — for network calls
 * only. UI render paths must use {@link loadRedactedGithubConnection}.
 * Fail-soft: malformed/absent → null.
 */
export function loadGithubConnection(store?: GithubConnectStorage): GithubConnection | null {
  const storage = store ?? defaultStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(GITHUB_CONNECT_KEY);
    return raw === null ? null : normalize(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Project a connection to the token-free view UI may render. */
export function redactedGithubConnection(conn: GithubConnection): RedactedGithubConnection {
  return { login: conn.login, hasToken: true };
}

/** Load the panel-safe (token-free) view of the stored connection, or null. */
export function loadRedactedGithubConnection(
  store?: GithubConnectStorage,
): RedactedGithubConnection | null {
  const conn = loadGithubConnection(store);
  return conn ? redactedGithubConnection(conn) : null;
}

/** Persist the connection. Best-effort: a failed write reports false, never throws. */
export function saveGithubConnection(
  conn: GithubConnection,
  store?: GithubConnectStorage,
): boolean {
  const storage = store ?? defaultStorage();
  if (!storage) return false;
  const normalized = normalize(conn);
  if (!normalized) return false;
  try {
    storage.setItem(GITHUB_CONNECT_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false; // quota / private mode
  }
}

/** Remove the stored connection entirely ("Disconnect" — wipes the PAT). */
export function clearGithubConnection(store?: GithubConnectStorage): void {
  const storage = store ?? defaultStorage();
  if (!storage) return;
  try {
    storage.removeItem(GITHUB_CONNECT_KEY);
  } catch {
    // best-effort
  }
}
