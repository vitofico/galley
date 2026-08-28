/**
 * Internal membership-read fuzz harness (Wave 13 cloud enabler; mirrors
 * auth-router.fuzz.test.ts). Asserts FAIL-SAFE on the highest-value attack class:
 * a request WITHOUT a validly-signed, in-window, right-claims token must NEVER
 * return 200 — no signature bypass, no alg-confusion, no claims skip — and no
 * input (garbage token, wrong key, wrong alg, junk path) ever throws instead of
 * answering a clean 401/404. A single genuinely-valid token is the ONLY 200.
 * Deterministic + fast (in-test EdDSA keypair, frozen clock).
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as jose from "jose";
import type { Hono } from "hono";
import { InMemoryProjectStore, InMemoryGroupStore } from "@galley/persistence";
import { createServiceTokenVerifier } from "@galley/auth";
import { createInternalMembershipRouter } from "./internal-membership-router.js";

const ISSUER = "https://cloud.galley.internal";
const AUDIENCE = "galley-self-host";
const NOW = 1_700_000_000_000;
const nowSec = Math.floor(NOW / 1000);
const PATH = "/projects/proj-1/membership/alice";

let priv: jose.KeyLike;
let app: Hono;

beforeAll(async () => {
  const kp = await jose.generateKeyPair("EdDSA", { extractable: true });
  priv = kp.privateKey;
  const pem = await jose.exportSPKI(kp.publicKey);
  const verify = await createServiceTokenVerifier({
    publicKeyPem: pem,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
  });
  const projects = new InMemoryProjectStore(() => "proj-1");
  const groups = new InMemoryGroupStore(() => "group-1");
  // alice IS a member, so a *valid* token here would 200 — proving the 401s below
  // are the auth gate refusing, not an empty store trivially answering null.
  await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
  await projects.addMember("proj-1", "alice", "editor");
  app = createInternalMembershipRouter({ verify, projects, groups });
});

describe("fuzz — nothing but a valid signature yields 200", () => {
  it("a battery of forged/garbage tokens never authenticates (all 401, never 200, never throws)", async () => {
    const wrongKey = await jose.generateKeyPair("EdDSA", { extractable: true });
    const forged: string[] = [
      "",
      "Bearer",
      "a.b.c",
      "....",
      "null",
      "e30.e30.", // {}.{}. — unsigned-ish
      "x".repeat(4096),
      // right shape, wrong signer:
      await new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300 })
        .setProtectedHeader({ alg: "EdDSA" })
        .sign(wrongKey.privateKey),
      // symmetric alg-confusion attempt:
      await new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300 })
        .setProtectedHeader({ alg: "HS256" })
        .sign(new TextEncoder().encode("guessed-secret-guessed-secret-32byte")),
      // valid signer but wrong claims / no exp:
      await new jose.SignJWT({ iss: "https://evil", aud: AUDIENCE, exp: nowSec + 300 })
        .setProtectedHeader({ alg: "EdDSA" })
        .sign(priv),
      await new jose.SignJWT({ iss: ISSUER, aud: "wrong", exp: nowSec + 300 })
        .setProtectedHeader({ alg: "EdDSA" })
        .sign(priv),
      await new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE }) // no exp
        .setProtectedHeader({ alg: "EdDSA" })
        .sign(priv),
      await new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: nowSec - 999 }) // expired
        .setProtectedHeader({ alg: "EdDSA" })
        .sign(priv),
    ];

    for (const t of forged) {
      const res = await app.request(PATH, { headers: { authorization: `Bearer ${t}` } });
      expect(res.status, JSON.stringify(t.slice(0, 24))).toBe(401);
    }

    // Control: the genuine token IS accepted (proves the gate isn't just refusing all).
    const good = await new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300 })
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(priv);
    const ok = await app.request(PATH, { headers: { authorization: `Bearer ${good}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ membership: { source: "project", role: "editor" } });
  });

  it("junk paths + methods never crash and never leak a 200 without auth", async () => {
    const paths = [
      "/",
      "/projects",
      "/projects//membership/",
      "/projects/../../etc/passwd/membership/x",
      "/projects/p/membership/u/extra",
      "/projects/%00/membership/%2e%2e",
      "/projects/p/membership/" + "u".repeat(2000),
    ];
    for (const p of paths) {
      const res = await app.request(p); // no auth header at all
      expect([401, 404], p).toContain(res.status);
      expect(res.status, p).not.toBe(200);
    }
  });
});
