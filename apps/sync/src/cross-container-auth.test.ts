/**
 * Cross-"container" auth durability (roadmap #4 hardening). Proves the core
 * property the shared session volume exists to provide: a session MINTED by the
 * web-server (one `FsSessionStore` instance at a dir) is VALIDATED by the sync
 * relay (a SEPARATE `FsSessionStore` instance at the SAME dir) through the real
 * sync authorization path — `authorizeSyncUpgrade` + `membershipAuthorizer`.
 *
 * Separate store instances over the same directory stand in for two containers
 * sharing one mounted volume; nothing is held in a shared in-memory map. Offline,
 * no Playwright, no socket — just the durable stores + the authorization core.
 *
 * Asserts: a member's upgrade is ALLOWED; a non-member is REJECTED; a
 * missing/expired session is REJECTED. The sync server turns a `false` from this
 * gate into a 1008 close (see sync-auth.test.ts) — here we assert the boolean the
 * server feeds that close on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSessionStore, FsProjectStore, membershipAuthorizer } from "@galley/persistence";
import { authorizeSyncUpgrade } from "@galley/auth";
import type { SessionRecord } from "@galley/shared";

const COOKIE = "__Host-galley.sid";
const cookieHeader = (id: string): string => `${COOKIE}=${id}`;

let sessionDir: string;
let dataDir: string;

beforeEach(async () => {
  sessionDir = await mkdtemp(join(tmpdir(), "galley-xc-sess-"));
  dataDir = await mkdtemp(join(tmpdir(), "galley-xc-data-"));
});
afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

/** The sync side: a fresh store instance at the SAME dirs (a different "container"). */
function syncGate() {
  const sessionStore = new FsSessionStore(sessionDir); // separate instance, same dir
  const authorizer = membershipAuthorizer(new FsProjectStore(dataDir));
  return (room: string, id: string | null, nowMs = 5_000) =>
    authorizeSyncUpgrade({
      cookieHeader: id ? cookieHeader(id) : undefined,
      room,
      sessionStore,
      authorizer,
      nowMs,
      cookieName: COOKIE,
    });
}

describe("cross-container session validation (web mints → sync validates)", () => {
  it("ALLOWS a member: web-minted session validates in the sync container", async () => {
    // Web container: create a project (room == projectId) + mint the user's session.
    const projects = new FsProjectStore(dataDir);
    const project = await projects.createProject({ name: "P", ownerId: "alice" });
    const web = new FsSessionStore(sessionDir);
    const { id } = await web.create(sessionRec("alice"));

    // Sync container (separate instances, same volume) authorizes the upgrade.
    expect(await syncGate()(project.id, id)).toBe(true);
  });

  it("REJECTS a non-member: a valid session for a project they don't belong to", async () => {
    const projects = new FsProjectStore(dataDir);
    const project = await projects.createProject({ name: "P", ownerId: "alice" });
    const web = new FsSessionStore(sessionDir);
    const { id } = await web.create(sessionRec("mallory")); // valid session, not a member

    expect(await syncGate()(project.id, id)).toBe(false); // server → 1008
  });

  it("REJECTS a missing session (no cookie / unknown id)", async () => {
    const projects = new FsProjectStore(dataDir);
    const project = await projects.createProject({ name: "P", ownerId: "alice" });

    expect(await syncGate()(project.id, null)).toBe(false); // no cookie
    expect(await syncGate()(project.id, "deadbeefdeadbeefdeadbeef")).toBe(false); // unknown id
  });

  it("REJECTS an expired session (web-minted, lapsed by the time sync checks)", async () => {
    const projects = new FsProjectStore(dataDir);
    const project = await projects.createProject({ name: "P", ownerId: "alice" });
    const web = new FsSessionStore(sessionDir);
    const { id } = await web.create(sessionRec("alice", { expiresAtMs: 1_000 }));

    // Member, but the session has expired before the sync container validates it.
    expect(await syncGate()(project.id, id, 2_000)).toBe(false);
  });
});

function sessionRec(userId: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return { userId, createdAtMs: 0, expiresAtMs: 10_000, ...over };
}
