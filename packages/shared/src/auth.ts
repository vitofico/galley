/**
 * Auth + session seam contracts (roadmap #4, ADR-0018 §3).
 *
 * Types only — the generic OIDC core (Authorization Code + PKCE) lives in
 * `@galley/auth`, the HTTP wiring + cookies in the auth router, the stores'
 * adapters in `@galley/persistence`/`@galley/auth`. Galley preserves a no-auth
 * single-user local mode by default; OIDC is opt-in for networked deploys and
 * works with ANY compliant IdP (discovery + JWKS), never a provider-specific one.
 */
import type { UserId } from "./persistence.js";

/** Static config for one OIDC provider (typically filled from discovery + env). */
export interface OidcProviderConfig {
  /** The issuer identifier (exact-matched against the ID token `iss`). */
  issuer: string;
  clientId: string;
  /** Optional confidential-client secret (client_secret_basic). PKCE public clients omit it. */
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Must be a configured, exact redirect URI (never derived from an untrusted Host). */
  redirectUri: string;
  /** Default ["openid", "profile", "email"]. */
  scopes?: string[];
}

/** The subset of ID-token claims we rely on (plus passthrough). */
export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  name?: string;
  [claim: string]: unknown;
}

/** The OIDC token endpoint response (only the fields we use). */
export interface OidcTokenResponse {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

/** A server-side session. The browser only ever holds the opaque session id (in an HttpOnly cookie). */
export interface SessionRecord {
  userId: UserId;
  createdAtMs: number;
  expiresAtMs: number;
  /** Audit/debug context for OIDC sessions (never the tokens themselves). */
  oidc?: { iss: string; sub: string };
  /**
   * Human-readable identity for the account UI (14-E): the ID token's `name`,
   * else `email`, captured at login. DISPLAY ONLY — never used for
   * authorization (that is `userId`). Optional, so pre-14-E persisted sessions
   * keep validating unchanged.
   */
  display?: string;
}

/**
 * Opaque server-side session storage. A fresh id is minted per login (we never
 * reuse an id → no session fixation); `deleteExpired` reaps lapsed sessions.
 */
export interface SessionStore {
  create(record: SessionRecord): Promise<{ id: string; record: SessionRecord }>;
  /** Raw read — does NOT enforce expiry. Auth code MUST use `getValid` instead. */
  get(id: string): Promise<SessionRecord | null>;
  /** Expiry-enforcing read: returns null (and deletes) if missing or expired. */
  getValid(id: string, nowMs: number): Promise<SessionRecord | null>;
  delete(id: string): Promise<void>;
  deleteExpired(nowMs: number): Promise<void>;
}

/** The short-lived per-login transaction state (CSRF/replay defense), keyed by `state`. */
export interface OidcLoginState {
  state: string;
  codeVerifier: string;
  nonce: string;
  /** Where to send the browser after a successful login (validated, same-origin). */
  returnTo: string;
  expiresAtMs: number;
}

/**
 * One-time login-state storage. `consume` ALWAYS deletes the entry (so a `state`
 * can never be replayed, even an expired one) and returns it only if still valid
 * at `nowMs` — expired states burn and return null.
 */
export interface OidcLoginStateStore {
  put(state: OidcLoginState): Promise<void>;
  consume(state: string, nowMs: number): Promise<OidcLoginState | null>;
}

/**
 * Map a sync-server room name to the project it belongs to. Today a room IS its
 * `projectId` (1:1); the helper exists so the convention has one home and can grow
 * (e.g. `project/<id>/<sub-room>`) without touching the authorizer or the server.
 */
export function projectIdFromSyncRoom(room: string): string {
  return room;
}
