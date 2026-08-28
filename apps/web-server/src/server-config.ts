/**
 * Pure OIDC auth-wiring decisions for the web-server, split out so the
 * fail-closed store resolution is unit-testable without discovery/network/socket.
 * See `server.ts` for the entrypoint.
 *
 * FAIL CLOSED: OIDC is only enabled for a networked, multi-container deploy, where
 * the sync relay authorizes a collaborator by reading the SAME durable session dir
 * the web-server wrote to. In-memory sessions live only in this process, so they
 * can NEVER be validated cross-process — auth would look "on" while no
 * collaborator could be authorized, and every restart would silently log everyone
 * out. Because that configuration cannot possibly work, `GALLEY_AUTH_MODE=oidc`
 * without `GALLEY_SESSION_DIR` THROWS at startup rather than degrading to
 * in-memory. The default no-auth path never reaches here.
 */
import { FsSessionStore, FsOidcLoginStateStore } from "@galley/persistence";
import type { OidcLoginStateStore, SessionStore } from "@galley/shared";

export type WebEnv = Record<string, string | undefined>;

export interface AuthStores {
  sessionStore: SessionStore;
  loginStateStore: OidcLoginStateStore;
}

/**
 * Strict enum parse of `GALLEY_AUTH_MODE`. Fail closed on a typo: an unrecognized
 * non-empty value (e.g. `"oidc "`, `"oid"`, `"on"`) THROWS rather than silently
 * disabling auth — a malformed toggle must never leave the server unauthenticated.
 * Trimmed + lowercased, so `"OIDC "` resolves to `"oidc"`.
 */
export function isOidcEnabled(env: WebEnv = process.env): boolean {
  const raw = env.GALLEY_AUTH_MODE?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "off") return false; // no auth (default, unchanged)
  if (raw === "oidc") return true;
  throw new Error(
    `GALLEY_AUTH_MODE has an unrecognized value. Refusing to start: accepted values are ` +
      `"oidc" (enable OIDC auth) or "off"/unset (no auth). A typo must never silently ` +
      `disable authentication.`,
  );
}

/**
 * `GALLEY_OIDC_ALLOW_HTTP=1` — dev/local-only: let OIDC discovery accept a
 * plain-`http:` issuer and plain-`http:` endpoints, so a self-hoster can sign in
 * against a local IdP that has no TLS (a Keycloak on
 * `http://idp.localtest.me:8090` inside a kind cluster). Default OFF: without it
 * discovery is https-only exactly as before, and a plain-http IdP throws at
 * startup.
 *
 * Parsed exactly like its sibling `GALLEY_INSECURE_COOKIES=1` — the LITERAL
 * string "1", nothing else (no trim, no case folding). And unlike
 * `GALLEY_AUTH_MODE` a typo does NOT throw: this toggle only ever RELAXES, so an
 * unrecognized value falls back to the strict https posture, which is the safe
 * outcome. The two flags pair up for a plain-http local deploy.
 *
 * What it costs: authentication of the IdP itself, not just confidentiality.
 * Discovery and JWKS come over an unverified channel, so an on-path attacker can
 * serve their own document and keys and forge a login as any user. The residual
 * checks still run but are not a defense on such a path — see
 * `DiscoverOidcOptions.allowHttp` in @galley/auth for the full blast radius. Http
 * ENDPOINTS are additionally conditional on the issuer being http, so this can
 * never downgrade a real https IdP behind a misconfigured proxy.
 *
 * The result is threaded into the discovery call explicitly; @galley/auth reads
 * no env of its own. The entrypoint only consults this under
 * `GALLEY_AUTH_MODE=oidc`, so the flag (and this warning) is inert otherwise.
 *
 * `warn` is injected so the startup warning is unit-testable; the entrypoint
 * calls this ONCE, so exactly one warning is logged per start.
 */
export function isOidcHttpAllowed(
  env: WebEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  if (env.GALLEY_OIDC_ALLOW_HTTP !== "1") return false;
  warn(
    "[galley/web-server] GALLEY_OIDC_ALLOW_HTTP=1: OIDC discovery will accept a " +
      "plain-http issuer and its plain-http endpoints. This gives up AUTHENTICATION of " +
      "the IdP, not just confidentiality: discovery and JWKS are fetched over a channel " +
      "nothing verifies, so anyone on the network path can answer with their own " +
      "document and signing keys and FORGE A LOGIN AS ANY USER — including an admin. " +
      "The remaining checks (exact issuer match, endpoint shape, signature-algorithm " +
      "allowlist, nonce, aud/azp, exp/iat) still run, but on an untrusted path every " +
      "value they check against comes from the attacker, so they are NOT a defense " +
      "there. Only ever use this where the entire path is trusted — a laptop, or " +
      "pod-to-pod inside a local kind cluster. LOCAL/DEV ONLY (pair it with " +
      "GALLEY_INSECURE_COOKIES=1); NEVER set it in production.",
  );
  return true;
}

/**
 * Build the durable, cross-container-shareable session + login-state stores.
 * Only call when {@link isOidcEnabled} is true. Throws (fail closed) if no durable
 * `GALLEY_SESSION_DIR` is configured — see the module note for why in-memory is
 * unsafe under OIDC.
 */
export function resolveAuthStores(env: WebEnv = process.env): AuthStores {
  const sessionDir = env.GALLEY_SESSION_DIR?.trim();
  if (!sessionDir) {
    throw new Error(
      "GALLEY_AUTH_MODE=oidc but GALLEY_SESSION_DIR is unset. Refusing to start: " +
        "in-memory sessions cannot be shared with the sync container (separate process), " +
        "so collaboration auth could never succeed and every restart would drop all " +
        "sessions. Mount a durable session volume into the web and sync containers and " +
        "set GALLEY_SESSION_DIR to the same path in both.",
    );
  }
  return {
    sessionStore: new FsSessionStore(sessionDir),
    loginStateStore: new FsOidcLoginStateStore(sessionDir),
  };
}

/**
 * Resolved config for the service-authenticated internal membership-read endpoint
 * (Wave 13 cloud enabler). All fields are trimmed and non-empty.
 */
export interface InternalMembershipConfig {
  /** SPKI PEM (or whole-PEM base64) public key that signs the caller's service tokens. */
  publicKeyPem: string;
  /** Expected token issuer (`iss`). */
  issuer: string;
  /** Expected token audience (`aud`). */
  audience: string;
  /** The shared projects/groups volume this endpoint reads membership from. */
  dataDir: string;
}

/**
 * Resolve the internal membership-read config from env, or `null` when the feature
 * is OFF — the default: ALL THREE `GALLEY_INTERNAL_SERVICE_*` vars absent.
 *
 * FAIL LOUD on a PARTIAL config. The three service-token vars are one unit (a
 * public key with no issuer/audience — or vice versa — can only be a deploy
 * mistake), and once they are set the endpoint needs the shared `GALLEY_DATA_DIR`
 * to read project/group membership. Any incomplete combination THROWS rather than
 * silently leaving the endpoint off (or, worse, half-wired and unable to answer).
 * This mirrors the fail-closed posture of `resolveAuthStores` and the sync
 * relay's `GALLEY_SYNC_AUTH=required` guards.
 */
export function resolveInternalMembershipConfig(
  env: WebEnv = process.env,
): InternalMembershipConfig | null {
  const publicKeyPem = env.GALLEY_INTERNAL_SERVICE_PUBLIC_KEY?.trim();
  const issuer = env.GALLEY_INTERNAL_SERVICE_ISSUER?.trim();
  const audience = env.GALLEY_INTERNAL_SERVICE_AUDIENCE?.trim();
  const present = [publicKeyPem, issuer, audience].filter((v): v is string => !!v);
  if (present.length === 0) return null; // feature off (default)
  if (present.length < 3) {
    throw new Error(
      "The internal membership-read endpoint requires ALL of " +
        "GALLEY_INTERNAL_SERVICE_PUBLIC_KEY, GALLEY_INTERNAL_SERVICE_ISSUER and " +
        "GALLEY_INTERNAL_SERVICE_AUDIENCE together, or none. Refusing to start on a " +
        "partial config: a service-token verifier missing its key/issuer/audience can " +
        "only be a deploy mistake.",
    );
  }
  const dataDir = env.GALLEY_DATA_DIR?.trim();
  if (!dataDir) {
    throw new Error(
      "The internal membership-read endpoint is configured (GALLEY_INTERNAL_SERVICE_* " +
        "set) but GALLEY_DATA_DIR is unset. Refusing to start: without the shared " +
        "projects/groups volume the endpoint could resolve no membership at all.",
    );
  }
  return {
    publicKeyPem: publicKeyPem as string,
    issuer: issuer as string,
    audience: audience as string,
    dataDir,
  };
}
