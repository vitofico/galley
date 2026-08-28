/**
 * @galley/auth — generic OIDC (Authorization Code + PKCE) auth core for Galley
 * (roadmap #4, ADR-0018 §3). IdP-agnostic (discovery + JWKS), framework-agnostic.
 *
 * Slices 4a + 4b: the pure flow logic + in-memory session/login-state stores
 * (deterministic, offline against a mocked IdP), plus `jose`-backed ID-token
 * SIGNATURE verification + OIDC discovery. The Hono route wiring + cookies are a
 * sibling slice (4c). Order is non-negotiable: `verifyIdToken` (signature, then
 * claims) authenticates — `validateIdTokenClaims` alone never does.
 */
export {
  generatePkce,
  randomToken,
  buildAuthorizationUrl,
  parseCallback,
  buildTokenRequest,
  parseTokenResponse,
  userIdFromOidc,
  validateIdTokenClaims,
} from "./oidc-core.js";
export type {
  RandomSource,
  Pkce,
  CallbackResult,
  TokenRequest,
  ClaimsValidationOptions,
  ClaimsResult,
} from "./oidc-core.js";
export { InMemorySessionStore, InMemoryOidcLoginStateStore } from "./stores.js";
export {
  verifyIdToken,
  remoteJwks,
  discoverOidcProvider,
  DEFAULT_ID_TOKEN_ALGS,
} from "./verify.js";
export type {
  JwksGetter,
  VerifyIdTokenOptions,
  VerifyResult,
  DiscoveredEndpoints,
  DiscoverOidcOptions,
} from "./verify.js";
export { createServiceTokenVerifier, SERVICE_TOKEN_ALGS } from "./service-token.js";
export type {
  ServiceTokenClaims,
  ServiceTokenVerifier,
  ServiceTokenVerifierOptions,
} from "./service-token.js";
export { authorizeSyncUpgrade, authorizeCapabilityRoomUpgrade, parseCookie } from "./upgrade.js";
export type { AuthorizeSyncUpgradeOptions } from "./upgrade.js";
export {
  registerCapabilityRoom,
  revokeCapabilityRoom,
  MAX_ACTIVE_CAPABILITY_ROOMS_PER_USER,
  MAX_ACTIVE_CONTROL_ROOMS_PER_USER,
  TOMBSTONE_CAP_PER_USER,
} from "./capability-rooms.js";
export type {
  CapabilityRoomRouteResult,
  CapabilityRoomErrorCode,
  RegisterCapabilityRoomInput,
  RevokeCapabilityRoomInput,
} from "./capability-rooms.js";
