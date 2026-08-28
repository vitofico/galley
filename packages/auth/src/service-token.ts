/**
 * Service-to-service token verification (Wave 13 cloud enabler). A private cloud
 * control plane calls the self-host web-server's internal membership-read endpoint
 * with a short-lived, asymmetrically-signed JWT; this verifies that token's
 * SIGNATURE against a configured SPKI public key with a strict `EdDSA` allowlist
 * BEFORE any claim is trusted — the same hard-gate posture as `verify.ts`'s
 * ID-token path (a claims check alone never authenticates).
 *
 * WHY THIS LIVES IN @galley/auth: `jose` is the crypto dependency and it is a
 * PRODUCTION dependency of @galley/auth ONLY — for apps/web-server it is a mere
 * devDependency. Importing `jose` from web-server code would therefore pass the
 * test run (jose is on the dev graph) yet CRASH the prod runtime image (jose is
 * not on web-server's prod graph). The verifier is built here and web-server
 * imports the ready-made function; jose never enters web-server's own source.
 */
import * as jose from "jose";

/**
 * Allowed service-token signature algorithm(s): asymmetric `EdDSA` only. NEVER
 * `none` or `HS*` — an HMAC alg would let a caller sign with the public key as
 * the shared secret (alg-confusion bypass). jose rejects `none` unconditionally.
 */
export const SERVICE_TOKEN_ALGS = ["EdDSA"] as const;

/** The verified, trusted claims a service token carries. `sub` (the calling service) is optional. */
export interface ServiceTokenClaims {
  iss: string;
  aud: string;
  /** Epoch SECONDS. Presence is REQUIRED (a service token without an expiry is rejected). */
  exp: number;
  sub?: string;
}

export interface ServiceTokenVerifierOptions {
  /**
   * The signer's SPKI PEM public key (`-----BEGIN PUBLIC KEY-----`…). A whole-PEM
   * base64 wrapping is also accepted (some env pipelines dislike embedded
   * newlines). Parsed ONCE at construction; a malformed key THROWS there.
   */
  publicKeyPem: string;
  /** Required exact issuer (`iss`). */
  issuer: string;
  /** Required exact audience (`aud`). */
  audience: string;
  /** Injected clock (ms) for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Clock-skew tolerance (seconds) for exp/nbf. Default 60. */
  clockToleranceSec?: number;
}

/** Verify a compact service token, returning its trusted claims, or `null` on ANY failure. */
export type ServiceTokenVerifier = (token: string) => Promise<ServiceTokenClaims | null>;

/**
 * Normalize an operator-supplied public key to SPKI PEM. A real PEM already
 * contains the `BEGIN`/`END` armor and is returned as-is; anything else is tried
 * as a whole-PEM base64 wrapping (decoded only when the result is itself armored).
 * A truly malformed value is returned unchanged so `importSPKI` throws on it.
 */
function normalizeSpkiPem(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("BEGIN")) return trimmed;
  try {
    const decoded = atob(trimmed);
    if (decoded.includes("BEGIN")) return decoded;
  } catch {
    // not base64 — fall through, let importSPKI reject it loudly
  }
  return trimmed;
}

/**
 * Fail loud on a public key that is not an Ed25519 (EdDSA) key. `importSPKI` derives
 * the key TYPE from the PEM's DER, NOT from the `"EdDSA"` hint, so an RSA/EC SPKI
 * imports "successfully" and then rejects EVERY real token at verify time — a silent,
 * boots-fine misconfiguration (security round finding 3). Assert the curve up front
 * so a wrong-key deploy aborts at startup, matching the malformed-key posture.
 * Handles both key representations jose may return (Node `KeyObject` / Web `CryptoKey`).
 */
function assertEd25519PublicKey(key: unknown): void {
  const asymmetricKeyType = (key as { asymmetricKeyType?: unknown }).asymmetricKeyType;
  if (typeof asymmetricKeyType === "string") {
    if (asymmetricKeyType !== "ed25519") {
      throw new Error(
        `internal service key must be an Ed25519 (EdDSA) public key, got "${asymmetricKeyType}"`,
      );
    }
    return;
  }
  const algName = (key as { algorithm?: { name?: unknown } }).algorithm?.name;
  if (typeof algName === "string") {
    if (algName !== "Ed25519" && algName !== "EdDSA") {
      throw new Error(`internal service key must be an Ed25519 (EdDSA) public key, got "${algName}"`);
    }
    return;
  }
  throw new Error("internal service key: unable to confirm it is an Ed25519 (EdDSA) public key");
}

/**
 * Build a service-token verifier. The SPKI key is imported ONCE here; a malformed
 * key REJECTS at construction (fail-loud startup — a verifier that can never
 * accept a genuine token must not silently exist). The returned function NEVER
 * throws: any failure (bad signature, disallowed/`none`/`HS*` alg, wrong or absent
 * `iss`/`aud`/`exp`, expired, garbage) resolves to `null`, so the route answers a
 * constant 401 with no leaked internals.
 *
 * Async because Web Crypto key import is async; `server.ts` awaits it during the
 * startup phase, so a bad key aborts boot exactly like any other config fault.
 */
export async function createServiceTokenVerifier(
  opts: ServiceTokenVerifierOptions,
): Promise<ServiceTokenVerifier> {
  const algorithms = [...SERVICE_TOKEN_ALGS];
  const now = opts.now ?? (() => Date.now());
  const clockTolerance = opts.clockToleranceSec ?? 60;
  const pem = normalizeSpkiPem(opts.publicKeyPem);
  // Reject an ambiguous/concatenated PEM: importSPKI silently takes only the FIRST
  // block, so a multi-key value would pick one non-deterministically. Fail loud.
  const blockCount = (pem.match(/-----BEGIN [^-]+-----/g) ?? []).length;
  if (blockCount !== 1) {
    throw new Error(`internal service key must be exactly one PEM block (found ${blockCount})`);
  }
  // Parse ONCE; a malformed key is a deploy misconfiguration → reject at startup.
  const key = await jose.importSPKI(pem, "EdDSA");
  assertEd25519PublicKey(key);

  return async (token: string): Promise<ServiceTokenClaims | null> => {
    let payload: jose.JWTPayload;
    try {
      // jose enforces, in one pass: signature (alg-allowlisted), `iss` === issuer
      // and `aud` includes audience (BOTH presence + match — a missing claim
      // fails), and exp/nbf validity WHEN PRESENT, against the injected clock.
      const res = await jose.jwtVerify(token, key, {
        algorithms,
        issuer: opts.issuer,
        audience: opts.audience,
        clockTolerance,
        currentDate: new Date(now()),
      });
      payload = res.payload;
    } catch {
      return null; // signature/claims invalid — no detail leaks to the caller
    }
    // exp PRESENCE is not enforced by jose (it only validates exp when present).
    // A service token MUST be short-lived, so an absent exp is a hard reject.
    if (typeof payload.exp !== "number") return null;
    // AUDIENCE must be the EXACT configured SCALAR. jose treats `aud` as an
    // inclusion match, so `aud:["us","other"]` (or a shared generic audience) would
    // otherwise verify and let a token minted for one deployment REPLAY against
    // another that shares the key + issuer (security round finding 2). Require the
    // single configured string — an array-valued or mismatched aud is rejected.
    // (Each deployment MUST be issued its own unique scalar audience.)
    if (payload.aud !== opts.audience) return null;
    return {
      iss: payload.iss as string, // validated === opts.issuer above
      aud: opts.audience, // validated to include opts.audience above
      exp: payload.exp,
      ...(typeof payload.sub === "string" ? { sub: payload.sub } : {}),
    };
  };
}
