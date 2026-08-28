/**
 * ID-token signature verification + OIDC discovery (roadmap #4 slice 4b,
 * ADR-0018 §3). The security-critical complement to the pure core: `jose`
 * verifies the ID-token SIGNATURE against trusted JWKS BEFORE any claim is
 * trusted, with a strict algorithm allowlist. Claims validation alone never
 * authenticates — this is the hard gate the slice-4a review mandated.
 *
 * `jose` is the only crypto dependency (pure ESM, Web Crypto) — no hand-rolled
 * JWT. All network I/O (JWKS, discovery) is injected for offline tests.
 */
import * as jose from "jose";
import type { IdTokenClaims } from "@galley/shared";
import { validateIdTokenClaims } from "./oidc-core.js";

/** A jose key resolver (from `createRemoteJWKSet` / `createLocalJWKSet`). */
export type JwksGetter = jose.JWTVerifyGetKey;

/**
 * Allowed ID-token signature algorithms. Asymmetric only — NEVER `none` or `HS*`
 * (an HMAC alg would let an attacker sign with the public key as the secret →
 * alg-confusion bypass). jose also rejects `none` unconditionally.
 */
export const DEFAULT_ID_TOKEN_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384"] as const;

/**
 * A JWKS resolver bound to a trusted `jwks_uri` (from config/discovery — never a
 * token-supplied header). jose caches keys, refreshes once on an unknown `kid`
 * with a cooldown, and selects by `kid` from THIS set — so a token's embedded
 * `jwk`/`jku`/`x5u` headers are ignored.
 */
export function remoteJwks(jwksUri: string): JwksGetter {
  return jose.createRemoteJWKSet(new URL(jwksUri));
}

export interface VerifyIdTokenOptions {
  jwks: JwksGetter;
  issuer: string;
  clientId: string;
  /** REQUIRED — the nonce minted at login (replay/injection defense). */
  nonce: string;
  nowMs: number;
  clockToleranceSec?: number;
  /** Signature alg allowlist (defaults to {@link DEFAULT_ID_TOKEN_ALGS}). */
  algorithms?: readonly string[];
}

export type VerifyResult = { ok: true; claims: IdTokenClaims } | { ok: false; reason: string };

/**
 * Verify an ID token end-to-end: signature (jose, alg-allowlisted) + iss/aud/exp/
 * nbf (jose) FIRST, then our extra claim checks (nonce, sub, iat, azp). Returns the
 * verified claims, or a reason. Never throws on an invalid token.
 */
export async function verifyIdToken(idToken: string, opts: VerifyIdTokenOptions): Promise<VerifyResult> {
  const algorithms = [...(opts.algorithms ?? DEFAULT_ID_TOKEN_ALGS)];
  const clockTolerance = opts.clockToleranceSec ?? 60;
  let payload: jose.JWTPayload;
  try {
    const res = await jose.jwtVerify(idToken, opts.jwks, {
      algorithms, // strict allowlist → rejects none / HS* / unexpected
      issuer: opts.issuer,
      audience: opts.clientId,
      clockTolerance,
      // Validate exp/nbf/iat against the SAME injected clock as validateIdTokenClaims
      // (deterministic; jose would otherwise use the real system time).
      currentDate: new Date(opts.nowMs),
    });
    payload = res.payload;
  } catch (err) {
    // Don't leak token internals; the name (e.g. JWSSignatureVerificationFailed,
    // JWTExpired, JWTClaimValidationFailed) is enough for diagnostics.
    return { ok: false, reason: `signature/claims invalid (${(err as Error).name})` };
  }

  // Signature + iss/aud/exp/nbf are now trusted. Layer the checks jose doesn't do
  // (nonce match, non-empty sub, numeric iat, azp) — belt-and-suspenders on the rest.
  const claims = payload as IdTokenClaims;
  const claimsRes = validateIdTokenClaims(claims, {
    issuer: opts.issuer,
    clientId: opts.clientId,
    nonce: opts.nonce,
    nowMs: opts.nowMs,
    ...(opts.clockToleranceSec !== undefined ? { clockToleranceSec: opts.clockToleranceSec } : {}),
  });
  if (!claimsRes.ok) return { ok: false, reason: claimsRes.reason };
  return { ok: true, claims };
}

export interface DiscoveredEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export interface DiscoverOidcOptions {
  /**
   * LOCAL/DEV escape hatch — default `false` (https required, unchanged). Must
   * be the LITERAL `true`; no other truthy value opens it.
   *
   * When `true`, a plain-`http:` issuer and, ONLY THEN, plain-`http:` endpoints
   * in its discovery document are accepted, so galley can sign in against an IdP
   * with no TLS to offer (a Keycloak on `http://idp.localtest.me:8090` inside a
   * kind cluster). An `https:` issuer NEVER gets http endpoints even with this
   * on — that combination is a misconfigured proxy in front of a real IdP, not a
   * local deploy. Schemes other than http/https stay rejected in both modes.
   *
   * BLAST RADIUS — this is a trust concession, not just an eavesdropping one.
   * Discovery and JWKS are fetched over a channel with no authentication, so
   * anyone on the network path can answer with their OWN document and key set
   * and thereby FORGE A LOGIN AS ANY USER. The other checks (exact issuer match,
   * endpoint shape, algorithm allowlist, nonce, aud/azp, exp/iat) all still run,
   * but on an untrusted path every value they check against is supplied by the
   * attacker, so they are not a defense there. Turn this on only where the whole
   * path is trusted: a laptop, or pod-to-pod inside a local kind cluster.
   *
   * This package is pure: the caller passes the option explicitly (the
   * web-server maps `GALLEY_OIDC_ALLOW_HTTP=1` onto it). @galley/auth never
   * reads `process.env`, so nothing can enable it implicitly.
   */
  allowHttp?: boolean;
}

/**
 * Fetch + validate an IdP's OpenID configuration. HTTPS-only by default, the
 * document's `issuer` must EXACTLY equal the configured issuer (mix-up defense),
 * and every endpoint must be HTTPS. `fetch` is injected for offline tests; see
 * {@link DiscoverOidcOptions.allowHttp} for the opt-in local-http hatch and the
 * trust it gives up.
 */
export async function discoverOidcProvider(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  opts: DiscoverOidcOptions = {},
): Promise<DiscoveredEndpoints> {
  // LITERAL true only. A truthy-but-not-boolean value (a "0" string from a
  // hand-rolled env parse, say) must never open the hatch.
  const allowHttp = opts.allowHttp === true;
  const issuerScheme = allowHttp ? "http(s)" : "https";
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const url = new URL(".well-known/openid-configuration", base);
  const httpIssuer = url.protocol === "http:";
  if (!(url.protocol === "https:" || (allowHttp && httpIssuer))) {
    throw new Error(`issuer must be ${issuerScheme}`);
  }
  // An http ENDPOINT is only tolerable when the issuer is itself http — i.e. the
  // wholly-local, no-TLS deploy this hatch exists for. An https issuer whose
  // document advertises http endpoints is the misconfigured-proxy footgun (a real
  // IdP behind a bad KC_HOSTNAME): today it fails at startup, and it must KEEP
  // failing even with the flag on, or a PRODUCTION code/token exchange would
  // silently drop to plaintext. Any scheme other than http/https stays rejected
  // in every mode.
  const allowHttpEndpoints = allowHttp && httpIssuer;
  const endpointScheme = allowHttpEndpoints ? "http(s)" : "https";
  const endpointOk = (protocol: string): boolean =>
    protocol === "https:" || (allowHttpEndpoints && protocol === "http:");
  const res = await fetchImpl(url.toString());
  if (!res.ok) throw new Error(`discovery failed: HTTP ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  if (doc.issuer !== issuer) throw new Error("discovery issuer mismatch");
  const pick = (k: string): string => {
    const v = doc[k];
    if (typeof v !== "string" || !endpointOk(new URL(v).protocol)) {
      throw new Error(`discovery ${k} missing or not ${endpointScheme}`);
    }
    return v;
  };
  return {
    issuer,
    authorizationEndpoint: pick("authorization_endpoint"),
    tokenEndpoint: pick("token_endpoint"),
    jwksUri: pick("jwks_uri"),
  };
}
