/**
 * The service-authenticated internal membership-read router (Wave 13 cloud
 * enabler). A single GET route answers `getMembership(projectId, userId)` for a
 * SERVICE caller — the private cloud control plane's project-access reader — so a
 * hosted deployment can resolve "can this user reach this project?" against the
 * self-host's own project/group stores over an authenticated server-to-server
 * hop. A self-hosted setup without it loses nothing: the endpoint is absent by
 * default (see `index.ts`).
 *
 * SECURITY POSTURE (Architect-ratified):
 *   - AUTH FIRST. The bearer token is verified BEFORE any identifier is parsed or
 *     any store is touched. A failure is a CONSTANT 401 (fixed body, no detail).
 *   - `Cache-Control: no-store` on EVERY response — an authorization answer must
 *     never be cached.
 *   - FAIL CLOSED on faults: a store error is a 503 (non-success), never a
 *     negative "not a member". The consumer treats 503 as "unknown → deny".
 *   - NO ORACLE: an unknown project and a real non-member both answer `200
 *     { membership: null }` — identical bytes, no project-existence probe.
 *
 * The jose-backed verifier is INJECTED (`deps.verify`) — it is built in
 * @galley/auth, so this file (and all of web-server) never imports `jose`, which
 * is only a devDependency here. See `service-token.ts`.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { GroupRole, GroupStore, MembershipReadResult, ProjectRole, ProjectStore } from "@galley/shared";
import type { ServiceTokenVerifier } from "@galley/auth";

export interface InternalMembershipDeps {
  /** Verifies the caller's bearer service token → trusted claims, or null. */
  verify: ServiceTokenVerifier;
  projects: ProjectStore;
  groups: GroupStore;
}

/**
 * The KNOWN role vocabularies. Defense-in-depth (security round finding 1): a store
 * value that is non-null but NOT a recognized role (data corruption, or a
 * prototype-pollution artifact — e.g. an inherited `Object.prototype` function that
 * survives a `!== null` check yet is dropped by `JSON.stringify`) must never
 * serialize a partial `{source:"project"}` body. Only a value in these sets counts
 * as membership; anything else is treated as "not a member".
 */
const PROJECT_ROLES: ReadonlySet<ProjectRole> = new Set<ProjectRole>(["owner", "editor", "viewer"]);
const GROUP_ROLES: ReadonlySet<GroupRole> = new Set<GroupRole>(["admin", "member"]);

/** The constant 401 body — no detail, no distinction between the failure modes. */
const UNAUTHORIZED_BODY = { error: "unauthorized" } as const;
/** The constant 503 body — a fault is "unavailable", never a membership answer. */
const UNAVAILABLE_BODY = { error: "unavailable" } as const;

/**
 * Resolve the membership read, re-implementing `projectOrGroupMembershipAuthorizer`
 * semantics (that function is boolean-only and stays untouched) but returning the
 * SOURCE + role rather than a boolean:
 *   (1) a direct project membership WINS outright — the group store is not consulted;
 *   (2) else, if the project exists and is group-owned, a membership of that group;
 *   (3) else `null`.
 *
 * Deliberately does NOT catch store errors: the route turns any throw into a 503
 * (the consumer fails closed), which is a strictly safer signal than a false
 * `null` ("definitely not a member").
 */
async function resolveMembership(
  projects: ProjectStore,
  groups: GroupStore,
  projectId: string,
  userId: string,
): Promise<MembershipReadResult> {
  const projectRole = await projects.getMembership(projectId, userId);
  // Only a RECOGNIZED role counts (see PROJECT_ROLES) — an unrecognized non-null
  // value is treated as "not a member" and falls through, never a partial body.
  if (projectRole !== null && PROJECT_ROLES.has(projectRole)) {
    return { source: "project", role: projectRole };
  }
  const ownerGroupId = (await projects.getProject(projectId))?.ownerGroupId;
  if (ownerGroupId !== undefined) {
    const groupRole = await groups.getMembership(ownerGroupId, userId);
    if (groupRole !== null && GROUP_ROLES.has(groupRole)) {
      return { source: "group", role: groupRole };
    }
  }
  return null; // non-member — INDISTINGUISHABLE from an unknown project
}

/** Read a `Bearer <token>` credential from the Authorization header, or "" when absent/ill-formed. */
function bearerToken(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

export function createInternalMembershipRouter(deps: InternalMembershipDeps): Hono {
  const { verify, projects, groups } = deps;
  const app = new Hono();

  app.get("/projects/:projectId/membership/:userId", async (c) => {
    // no-store on ALL responses (set FIRST so 401/503/200 all carry it).
    c.header("cache-control", "no-store");

    // AUTH FIRST — verify BEFORE parsing identifiers or touching a store.
    const token = bearerToken(c);
    const claims = token ? await verify(token) : null;
    if (!claims) return c.json(UNAUTHORIZED_BODY, 401);

    const projectId = c.req.param("projectId");
    const userId = c.req.param("userId");
    let membership: MembershipReadResult;
    try {
      membership = await resolveMembership(projects, groups, projectId, userId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[galley/web-server] internal membership read failed:", err);
      return c.json(UNAVAILABLE_BODY, 503);
    }
    return c.json({ membership });
  });

  return app;
}
