/**
 * The service-authenticated internal membership-read router (Wave 13 cloud
 * enabler), driven offline through Hono's `app.request`. Uses a REAL EdDSA keypair
 * (jose is a web-server devDependency — fine in tests) and the in-memory
 * project/group stores. Pins the security contract the private cloud consumer
 * relies on: auth-before-anything (401 before a store is touched), no-oracle
 * membership resolution (unknown project ≡ non-member), direct-wins-over-group,
 * fail-closed 503 on store faults, no-store on every response, the load-bearing
 * mount order (unauth → 401, NOT the SPA shell), and the byte-for-byte no-op when
 * the feature is off.
 *
 * PRODUCTION-DEP BOUNDARY: the verifier is imported from "@galley/auth" (its
 * public API) — never `jose`. jose is only a devDependency of web-server, so
 * importing it from web-server SOURCE would pass tests yet crash the prod image.
 * A source guard below pins that boundary.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as jose from "jose";
import type { Hono } from "hono";
import { InMemoryProjectStore, InMemoryGroupStore } from "@galley/persistence";
import { createServiceTokenVerifier, type ServiceTokenVerifier } from "@galley/auth";
import { createInternalMembershipRouter } from "./internal-membership-router.js";
import { createWebServerApp, type StaticFiles } from "./index.js";

const ISSUER = "https://cloud.galley.internal";
const AUDIENCE = "galley-self-host";
const NOW = 1_700_000_000_000;
const nowSec = Math.floor(NOW / 1000);
const PATH = "/projects/proj-1/membership/alice";

let priv: jose.KeyLike;
let pem: string;

beforeAll(async () => {
  const kp = await jose.generateKeyPair("EdDSA", { extractable: true });
  priv = kp.privateKey;
  pem = await jose.exportSPKI(kp.publicKey);
});

async function verifier(): Promise<ServiceTokenVerifier> {
  return createServiceTokenVerifier({ publicKeyPem: pem, issuer: ISSUER, audience: AUDIENCE, now: () => NOW });
}

async function token(over: Record<string, unknown> = {}): Promise<string> {
  return new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300, sub: "control-plane", ...over })
    .setProtectedHeader({ alg: "EdDSA" })
    .sign(priv);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function setup() {
  const projects = new InMemoryProjectStore(() => "proj-1"); // deterministic id
  const groups = new InMemoryGroupStore(() => "group-1");
  const verify = await verifier();
  const router = createInternalMembershipRouter({ verify, projects, groups });
  return { router, projects, groups, verify };
}

/** Path against a router mounted at /internal (the full app), or a bare router. */
function reqPath(mounted: boolean, path = PATH): string {
  return mounted ? `/internal${path}` : path;
}

describe("internal membership router — auth gate", () => {
  it("returns a CONSTANT 401 and touches NO store when the token is missing/invalid", async () => {
    const { router, projects } = await setup();
    let storeTouched = false;
    const origGM = projects.getMembership.bind(projects);
    projects.getMembership = async (p, u) => {
      storeTouched = true;
      return origGM(p, u);
    };
    const origGP = projects.getProject.bind(projects);
    projects.getProject = async (id) => {
      storeTouched = true;
      return origGP(id);
    };

    const none = await router.request(PATH);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });
    expect(none.headers.get("cache-control")).toBe("no-store");

    const bogus = await router.request(PATH, { headers: auth("not.a.valid.token") });
    expect(bogus.status).toBe(401);

    const expired = await router.request(PATH, { headers: auth(await token({ exp: nowSec - 120 })) });
    expect(expired.status).toBe(401);

    expect(storeTouched).toBe(false); // auth ran BEFORE any store access
  });
});

describe("internal membership router — resolution", () => {
  it("a DIRECT project member ⇒ { source: 'project', role }", async () => {
    const { router, projects } = await setup();
    await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
    await projects.addMember("proj-1", "alice", "editor");
    const res = await router.request(PATH, { headers: auth(await token()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membership: { source: "project", role: "editor" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a GROUP-derived member ⇒ { source: 'group', role } (not a direct project member)", async () => {
    const { router, projects, groups } = await setup();
    await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
    await groups.createGroup("Lab", "admin-user");
    await groups.addMember("group-1", "alice", "member");
    await projects.updateProject("proj-1", { ownerGroupId: "group-1" });
    const res = await router.request(PATH, { headers: auth(await token()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membership: { source: "group", role: "member" } });
  });

  it("DIRECT membership WINS over the owning group (member of both, group never consulted)", async () => {
    const { router, projects, groups } = await setup();
    await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
    await projects.addMember("proj-1", "alice", "viewer"); // direct viewer
    await groups.createGroup("Lab", "alice"); // alice is admin of the owning group
    await projects.updateProject("proj-1", { ownerGroupId: "group-1" });

    let groupConsulted = false;
    const origGGM = groups.getMembership.bind(groups);
    groups.getMembership = async (g, u) => {
      groupConsulted = true;
      return origGGM(g, u);
    };

    const res = await router.request(PATH, { headers: auth(await token()) });
    expect(await res.json()).toEqual({ membership: { source: "project", role: "viewer" } });
    expect(groupConsulted).toBe(false); // short-circuit on direct membership
  });

  it("unknown project and a real non-member answer IDENTICALLY (200, membership: null — no oracle)", async () => {
    const { router, projects } = await setup();
    // (a) unknown project — nothing created at all.
    const unknown = await router.request(PATH, { headers: auth(await token()) });
    // (b) known project, but alice is not a member (owner is someone else, no group).
    await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
    const nonMember = await router.request(PATH, { headers: auth(await token()) });

    expect(unknown.status).toBe(200);
    expect(nonMember.status).toBe(200);
    const a = await unknown.json();
    const b = await nonMember.json();
    expect(a).toEqual({ membership: null });
    expect(a).toEqual(b); // byte-identical answer — not a project-existence probe
  });

  it("a project group-owned by a group the user is NOT in ⇒ null", async () => {
    const { router, projects, groups } = await setup();
    await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
    await groups.createGroup("Lab", "someone-else");
    await projects.updateProject("proj-1", { ownerGroupId: "group-1" });
    const res = await router.request(PATH, { headers: auth(await token()) });
    expect(await res.json()).toEqual({ membership: null });
  });
});

describe("internal membership router — fail closed", () => {
  it("a store fault ⇒ 503 (non-success), constant body, no-store — never a false 'not a member'", async () => {
    const { router, projects } = await setup();
    projects.getMembership = async () => {
      throw new Error("store unavailable");
    };
    const res = await router.request(PATH, { headers: auth(await token()) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a hostile :projectId the production Fs gate would reject ⇒ fail-closed 503 (no traversal, no crash, no 200)", async () => {
    // In production the stores are FsProjectStore/FsGroupStore, whose `dir()` runs
    // `assertSafeId` (SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/) BEFORE building any path,
    // so a traversal-shaped or oversized id THROWS before touching disk. The route
    // must turn that into a fail-closed 503 — an authenticated caller can never
    // provoke a path escape, an unhandled crash, or a misleading 200. In-memory
    // stores don't enforce that gate, so mirror it here at the router boundary.
    const { router, projects } = await setup();
    const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
    const origGM = projects.getMembership.bind(projects);
    projects.getMembership = async (p, u) => {
      if (!SAFE_KEY.test(p)) throw new Error(`illegal project id: ${JSON.stringify(p)}`);
      return origGM(p, u);
    };
    for (const evil of ["../../etc/passwd", "a/../../b", "%2e%2e", "x".repeat(200)]) {
      const res = await router.request(
        `/projects/${encodeURIComponent(evil)}/membership/alice`,
        { headers: auth(await token()) },
      );
      expect(res.status, evil).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    }
  });

  it("a store returning a NON-enum role (prototype-pollution artifact) ⇒ membership null, never a partial body", async () => {
    // Defense-in-depth (finding 1): the exact pre-fix artifact is an inherited
    // Object.prototype function that survives `!== null` yet is dropped by
    // JSON.stringify → the reported `{source:"project"}` partial body. The router's
    // enum guard must reject any non-recognized role and answer null instead.
    const { router, projects } = await setup();
    await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
    projects.getMembership = (async () => ({}).toString) as unknown as typeof projects.getMembership;
    const res = await router.request(PATH, { headers: auth(await token()) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ membership: null });
    expect(JSON.stringify(body)).not.toContain("project"); // never a partial {source:"project"}
  });
});

/** In-memory SPA shell for the full-app mount tests. */
const shell = "<!doctype html><title>Galley</title><div id=root></div>";
function fakeFiles(): StaticFiles {
  const enc = new TextEncoder();
  return { read: async (rel) => (rel === "index.html" ? enc.encode(shell) : null) };
}

async function fullApp(withFeature: boolean): Promise<Hono> {
  const projects = new InMemoryProjectStore(() => "proj-1");
  const groups = new InMemoryGroupStore(() => "group-1");
  const verify = await verifier();
  return createWebServerApp({
    files: fakeFiles(),
    ...(withFeature ? { internalMembership: { verify, projects, groups } } : {}),
  });
}

describe("mount order (load-bearing) + off-by-default no-op", () => {
  it("MOUNTED: an unauthenticated /internal/* request is a 401 from the auth gate, NOT the SPA shell", async () => {
    const app = await fullApp(true);
    const res = await app.request(reqPath(true));
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain("<!doctype html>"); // gate answered, wildcard did not
    expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("MOUNTED + valid token still resolves through the full app (proves the mount reaches the route)", async () => {
    const projects = new InMemoryProjectStore(() => "proj-1");
    const groups = new InMemoryGroupStore(() => "group-1");
    await projects.createProject({ id: "proj-1", name: "P", ownerId: "owner" });
    await projects.addMember("proj-1", "alice", "owner");
    const verify = await verifier();
    const app = createWebServerApp({ files: fakeFiles(), internalMembership: { verify, projects, groups } });
    const res = await app.request(reqPath(true), { headers: auth(await token()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membership: { source: "project", role: "owner" } });
  });

  it("OFF by default: /internal/* falls through to the SPA shell BYTE-FOR-BYTE (no behavior change)", async () => {
    const app = await fullApp(false);
    const feature = await app.request(reqPath(true)); // /internal/...
    const control = await app.request("/some/other/client/route"); // any SPA nav path
    expect(feature.status).toBe(200);
    expect(control.status).toBe(200);
    const featureBody = await feature.text();
    expect(featureBody).toBe(shell); // identical to the plain SPA shell
    expect(featureBody).toBe(await control.text());
    // Off-by-default surface must NOT advertise itself as an auth endpoint (no 401).
    expect(feature.headers.get("cache-control")).not.toBe("no-store");
  });
});

describe("production-dependency boundary (jose stays in @galley/auth)", () => {
  it("web-server SOURCE never imports jose (it is only a devDependency here)", () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    for (const rel of ["./internal-membership-router.ts", "./index.ts"]) {
      expect(read(rel), rel).not.toMatch(/from\s+["']jose["']/);
      expect(read(rel), rel).not.toMatch(/import\s*\(\s*["']jose["']/);
    }
  });

  it("the verifier is reachable through @galley/auth's public API", () => {
    expect(typeof createServiceTokenVerifier).toBe("function");
  });
});
