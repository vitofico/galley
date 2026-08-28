/**
 * The pure, IdP-agnostic OIDC Authorization Code + PKCE core (roadmap #4,
 * ADR-0018 §3). No HTTP, no cookies, no signature verification (that's the
 * `jose`-backed sibling slice) — just the flow logic, deterministic given an
 * injected random source. Built on the platform Web Crypto (`crypto.subtle`),
 * no external dependency.
 */
import type {
  IdTokenClaims,
  OidcProviderConfig,
  OidcTokenResponse,
  UserId,
} from "@galley/shared";

/** Cryptographically-random byte source. Injectable for deterministic tests. */
export type RandomSource = (byteLength: number) => Uint8Array;
const defaultRandom: RandomSource = (n) => crypto.getRandomValues(new Uint8Array(n));

const DEFAULT_SCOPES = ["openid", "profile", "email"];

/** base64url (no padding) of raw bytes. */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

/** A high-entropy, URL-safe token (state, nonce, session ids). 32 bytes → 256 bits. */
export function randomToken(random: RandomSource = defaultRandom, byteLength = 32): string {
  return b64url(random(byteLength));
}

export interface Pkce {
  codeVerifier: string;
  codeChallenge: string;
  method: "S256";
}

/** Generate a PKCE verifier + S256 challenge (RFC 7636). */
export async function generatePkce(random: RandomSource = defaultRandom): Promise<Pkce> {
  const codeVerifier = b64url(random(32)); // 43-char high-entropy verifier
  return { codeVerifier, codeChallenge: b64url(await sha256(codeVerifier)), method: "S256" };
}

/** Build the IdP authorization redirect URL. */
export function buildAuthorizationUrl(
  config: OidcProviderConfig,
  params: { state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizationEndpoint);
  const scopes = config.scopes ?? DEFAULT_SCOPES;
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type CallbackResult =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string; state?: string };

/** Parse + minimally validate the IdP redirect-back query (`?code&state` or `?error`). */
export function parseCallback(query: URLSearchParams | Record<string, string>): CallbackResult {
  const get = (k: string): string | null =>
    query instanceof URLSearchParams ? query.get(k) : (query[k] ?? null);
  const state = get("state") ?? undefined;
  const error = get("error");
  if (error) return state === undefined ? { ok: false, error } : { ok: false, error, state };
  const code = get("code");
  if (!code || !state) {
    const base = { ok: false as const, error: "missing code or state" };
    return state === undefined ? base : { ...base, state };
  }
  return { ok: true, code, state };
}

export interface TokenRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Shape the code→token exchange request (the wiring layer performs the fetch). */
export function buildTokenRequest(
  config: OidcProviderConfig,
  params: { code: string; codeVerifier: string },
): TokenRequest {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: params.codeVerifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  // Confidential client → client_secret_basic. Public PKCE client omits the secret.
  // RFC 6749 §2.3.1: form-urlencode each credential BEFORE joining with ":" — so a
  // ":" or non-ASCII char in the id/secret can't corrupt the header.
  if (config.clientSecret !== undefined && config.clientSecret !== "") {
    const cred = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
    headers.authorization = `Basic ${btoa(cred)}`;
  }
  return { url: config.tokenEndpoint, method: "POST", headers, body: body.toString() };
}

/** Validate + narrow an untrusted token endpoint response. */
export function parseTokenResponse(json: unknown): OidcTokenResponse {
  if (typeof json !== "object" || json === null) throw new Error("token response is not an object");
  const o = json as Record<string, unknown>;
  if (typeof o.id_token !== "string" || o.id_token.length === 0) {
    throw new Error("token response missing id_token");
  }
  const out: OidcTokenResponse = { id_token: o.id_token };
  if (typeof o.access_token === "string") out.access_token = o.access_token;
  if (typeof o.token_type === "string") out.token_type = o.token_type;
  if (typeof o.expires_in === "number") out.expires_in = o.expires_in;
  if (typeof o.refresh_token === "string") out.refresh_token = o.refresh_token;
  return out;
}

/** Map a verified `{iss, sub}` to a stable, opaque, storage-safe Galley user id. */
export async function userIdFromOidc(iss: string, sub: string): Promise<UserId> {
  // NUL-delimited so distinct (iss,sub) pairs can't collide via concatenation
  // (pinned in oidc-core.test.ts). The delimiter MUST be written as the `\x00`
  // ESCAPE and NEVER as a raw 0x00 byte: a raw NUL makes git classify this file
  // as BINARY (no diffs, no blame, `git grep -I` skips it) and most text
  // renderers show it as a space -- which already fooled a reviewer into filing
  // a phantom cross-issuer-collision finding. The escape is byte-identical at
  // runtime, so stored `oidc:` ids stay stable.
  return `oidc:${b64url(await sha256(`${iss}\x00${sub}`))}`;
}

export interface ClaimsValidationOptions {
  issuer: string;
  clientId: string;
  /** The nonce minted at login — REQUIRED to match (replay/injection defense). */
  nonce?: string;
  nowMs: number;
  clockToleranceSec?: number;
}

export type ClaimsResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate ID-token CLAIMS (OIDC Core §3.1.3.7) — issuer, audience, azp,
 * expiry/nbf with clock tolerance, and nonce. Signature verification is a
 * SEPARATE step (jose, sibling slice); claims-only validation must never be
 * trusted alone for authentication.
 */
export function validateIdTokenClaims(claims: IdTokenClaims, opts: ClaimsValidationOptions): ClaimsResult {
  const tol = opts.clockToleranceSec ?? 60;
  const now = Math.floor(opts.nowMs / 1000);
  if (claims.iss !== opts.issuer) return { ok: false, reason: "iss mismatch" };
  // A signed-but-malformed token must not collapse identity (e.g. missing `sub`).
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return { ok: false, reason: "missing sub" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) return { ok: false, reason: "aud mismatch" };
  // `azp`, if present, must be our client; and with multiple audiences it is required.
  if (claims.azp !== undefined && claims.azp !== opts.clientId) return { ok: false, reason: "azp mismatch" };
  if (aud.length > 1 && claims.azp !== opts.clientId) return { ok: false, reason: "azp required (multi-aud)" };
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) return { ok: false, reason: "missing iat" };
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || now > claims.exp + tol) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && (!Number.isFinite(claims.nbf) || now + tol < claims.nbf)) {
    return { ok: false, reason: "not yet valid" };
  }
  // Nonce is mandatory: must be supplied AND must match (replay/injection defense).
  if (opts.nonce === undefined) return { ok: false, reason: "no nonce to verify against" };
  if (claims.nonce !== opts.nonce) return { ok: false, reason: "nonce mismatch" };
  return { ok: true };
}
