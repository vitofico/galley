/**
 * Test-only OpenID Connect provider (node:http + node:crypto, no deps), so the
 * server-copy e2e signs in through the REAL web-server login: discovery,
 * authorization-code + PKCE, an RS256 ID token and its JWKS.
 *
 * It approves every authorization request for one fixed person and has no
 * login page: the property under test is what Galley keeps for a signed-in
 * account, not the provider's own UI. Never deploy it.
 */
import { createServer } from "node:http";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

const PORT = Number(process.env.OIDC_PORT ?? 4180);
const ISSUER = `http://localhost:${PORT}`;
const SUBJECT = "e2e-user";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "e2e";
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

const b64url = (value) => Buffer.from(value).toString("base64url");

/** Authorization codes awaiting exchange: code → the request that minted it. */
const codes = new Map();

function idToken(clientId, nonce) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const body = b64url(
    JSON.stringify({
      iss: ISSUER,
      sub: SUBJECT,
      aud: clientId,
      iat: now,
      exp: now + 600,
      nonce,
      name: "Ada",
      email: "ada@example.test",
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (url.pathname === "/.well-known/openid-configuration")
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
  if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
  if (url.pathname === "/authorize") {
    const q = url.searchParams;
    const redirect = q.get("redirect_uri");
    if (!redirect || q.get("response_type") !== "code") return json(res, 400, {});
    const code = randomBytes(16).toString("base64url");
    codes.set(code, {
      clientId: q.get("client_id"),
      nonce: q.get("nonce"),
      challenge: q.get("code_challenge"),
      redirect,
    });
    const back = new URL(redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        !grant ||
        grant.redirect !== form.get("redirect_uri") ||
        grant.challenge !== challenge
      )
        return json(res, 400, { error: "invalid_grant" });
      json(res, 200, {
        id_token: idToken(grant.clientId, grant.nonce),
        access_token: randomBytes(16).toString("base64url"),
        token_type: "Bearer",
        expires_in: 600,
      });
    });
    return;
  }
  json(res, 404, {});
}).listen(PORT, () => console.log(`[e2e oidc] ${ISSUER}`));
