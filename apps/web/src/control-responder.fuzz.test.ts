/**
 * Adversarial property/fuzz harness for the Agent Access RESPONDER CORE
 * (control-responder.ts), wave-33 #22.2 — the LAST light security surfaces.
 *
 * The core was already verified-by-construction in #16.3 (control-responder.test.ts
 * mirrors the kernel's acceptance rules and pins every refusal path). This harness
 * is the SECOND wall: it sweeps DETERMINISTICALLY GENERATED hostile inputs across
 * the whole open_project / list_* dispatch and asserts the two load-bearing
 * invariants hold for EVERY one of them:
 *
 *   INV-1 (fail-closed totality): answerControlRequest NEVER throws and ALWAYS
 *     returns a response carrying the request's correlation id — no seam throw,
 *     malformed param, or hostile handoff can wedge the drain loop or drop an id.
 *
 *   INV-2 (no capability / peer-text leak on refusal): an ok:false response NEVER
 *     echoes the offered (hostile) syncUrl text, and an ok:true open_project
 *     response ONLY ever carries a kernel-valid {share-room, loopback|relay
 *     syncUrl, safe mainFile, echoed projectId} — a malformed handoff is refused,
 *     never forwarded.
 *
 * DETERMINISM: every input is derived from the loop index (no Math.random / no
 * Date.now), so a failure is reproducible from its index. These cases also seed
 * the #22.3 corpus.
 *
 * typecheck-poison guard (lane contract): NO import from apps/mcp/** — the kernel
 * rules are mirrored inline, matching control-responder.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { ControlRequest } from "@galley/collab";
import {
  answerControlRequest,
  OPEN_REFUSAL_MAX_CHARS,
  type ControlResponderSeams,
  type OpenedProject,
  type OpenProjectRefusal,
} from "./control-responder.js";

// Mirror of the kernel's PROJECT_ROOM_RE (control-tools.ts) for assertion only.
const KERNEL_PROJECT_ROOM_RE = /^share-[A-Za-z0-9-]{16,}$/;
const A_ROOM = "share-11112222333344445555";
const A_SYNC = "ws://127.0.0.1:1234";
const CONTROL_ROOM = "share-controlcontrolcontrol";
const A_GRANT = "g0aBcDeF1234_-ZyXwVu"; // a base64url-shaped per-grant token

function req(op: string, params: Record<string, unknown> = {}, id = "id-corr-000000"): ControlRequest {
  return { id, op, params, createdAt: 1 };
}

function honestSeams(over: Partial<ControlResponderSeams> = {}): ControlResponderSeams {
  return {
    configuredSyncUrl: A_SYNC,
    controlRoom: CONTROL_ROOM,
    listProjects: async () => [{ projectId: "proj-1", name: "Alpha", lastModified: 100 }],
    listVersions: async (projectId) =>
      projectId === "proj-1" ? [{ id: "v1", name: "Draft" }] : null,
    createProject: async (name) => ({ projectId: "proj-new", name }),
    openProjectForControl: async (projectId) =>
      projectId === "proj-1" ? { room: A_ROOM, syncUrl: A_SYNC, mainFile: "main.typ", grantId: A_GRANT } : null,
    versionTree: async (projectId, versionId) =>
      projectId === "proj-1" && versionId === "v1" ? [{ path: "/main.typ", text: "body" }] : null,
    ...over,
  };
}

/** Recursively collect every string value in a payload (capability/peer-text leak checks). */
function allStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, acc);
  else if (value && typeof value === "object") for (const v of Object.values(value)) allStrings(v, acc);
  return acc;
}

/**
 * A deterministic pool of HOSTILE syncUrls a malicious/sloppy open seam might
 * return. NONE of these is loopback-or-configured-relay except the two honest
 * controls, so all but those must be REFUSED — and the refusal must never echo
 * the hostile text (INV-2). Index-addressable for reproducibility.
 */
const HOSTILE_SYNC_URLS: readonly string[] = [
  "ws://evil.example.com:1234", // foreign relay
  "wss://attacker.test/sync", // foreign relay (wss)
  "ws://user:pass@127.0.0.1:1234", // credentials, even on loopback
  "ws://127.0.0.1:1234/?leak=secret", // query
  "ws://127.0.0.1:1234/#frag", // fragment
  "http://127.0.0.1:1234", // non-ws scheme
  "https://127.0.0.1:1234", // non-ws scheme
  "ftp://127.0.0.1", // non-ws scheme
  "ws://169.254.169.254/", // link-local (not loopback)
  "ws://0.0.0.0:1234", // unspecified (not loopback)
  "ws://10.0.0.5:1234", // private, not loopback, not relay
  "wss://[::ffff:7f00:1]:1234", // IPv4-mapped loopback (NOT matched by hostname rule → must refuse)
  "ws://127.0.0.1.evil.com:1234", // loopback-prefixed hostname spoof
  "ws://localhost.evil.com:1234", // localhost-prefixed spoof
  "not-a-url-at-all", // unparseable / non-ws
  "ws://" + "h".repeat(5000), // over-length
];

/** Deterministic pool of hostile room ids: none is a fresh share-room except the control. */
const HOSTILE_ROOMS: readonly string[] = [
  "proj-1", // stable project id, not a share cap
  "share-short", // too short (<16 body)
  "control", // not share-prefixed
  CONTROL_ROOM, // the control room itself
  "share-has spaces in it 0000", // illegal chars
  "share-" + "x".repeat(500), // over-length (>maxRoomChars)
  "", // empty
  "SHARE-11112222333344445555", // wrong-case prefix
];

/** Deterministic pool of hostile mainFile paths: none is a safe in-tree path. */
const HOSTILE_PATHS: readonly string[] = [
  "../escape.typ", // traversal (normalized to /../escape.typ -> '..' segment)
  "../../etc/passwd", // traversal
  "/.galley/instructions", // reserved namespace
  "a/../../../b.typ", // traversal after normalization
  "main\u0000.typ", // NUL control char
  "foo\\bar.typ", // backslash segment
  "", // empty
  "/a//b.typ", // empty segment
  "/dir/bell\u0007.typ", // BEL control char
  "/dir/sub/../../../../etc", // deep traversal
];

describe("control-responder core — fuzz: INV-1 fail-closed totality", () => {
  it("never throws and always carries the id across a deterministic op×param sweep", async () => {
    const ops = [
      "list_projects",
      "list_versions",
      "list_version_files",
      "read_version_file",
      "open_project",
      "delete_everything", // unsupported
      "", // empty op
      "OPEN_PROJECT", // wrong case
      "__proto__", // prototype-pollution-shaped op name
    ];
    for (let i = 0; i < 400; i++) {
      const op = ops[i % ops.length]!;
      // Deterministically vary the projectId param: known / unknown / absent / ill-typed.
      const variant = i % 4;
      const params: Record<string, unknown> =
        variant === 0
          ? { projectId: "proj-1" }
          : variant === 1
            ? { projectId: `unknown-${i}` }
            : variant === 2
              ? {}
              : { projectId: i }; // ill-typed (number, not string)
      const id = `corr-${i}`;
      const res = await answerControlRequest(req(op, params, id), honestSeams());
      expect(res.id).toBe(id);
      expect(typeof res.ok).toBe("boolean");
      if (!res.ok) expect(typeof res.error).toBe("string");
    }
  });

  it("a seam that throws on ANY op is refused (never an unhandled rejection)", async () => {
    const ops = [
      "list_projects",
      "list_versions",
      "list_version_files",
      "read_version_file",
      "open_project",
    ];
    for (let i = 0; i < ops.length; i++) {
      const boom = async () => {
        throw new Error(`seam boom secret-internal-detail-${i}`);
      };
      const seams = honestSeams({
        listProjects: boom as never,
        listVersions: boom as never,
        versionTree: boom as never,
        openProjectForControl: boom as never,
      });
      const res = await answerControlRequest(
        req(ops[i]!, { projectId: "proj-1", versionId: "v1", path: "/main.typ" }),
        seams,
      );
      expect(res.ok).toBe(false);
      // The seam's internal error text must NEVER ride back to the kernel.
      if (!res.ok) expect(res.error).not.toContain("secret-internal-detail");
    }
  });
});

describe("control-responder core — fuzz: INV-2 hostile open_project handoffs are refused, no leak", () => {
  it("every hostile syncUrl is refused and never echoed in the error", async () => {
    for (let i = 0; i < HOSTILE_SYNC_URLS.length; i++) {
      const syncUrl = HOSTILE_SYNC_URLS[i]!;
      const seams = honestSeams({
        openProjectForControl: async (): Promise<OpenedProject> => ({ room: A_ROOM, syncUrl, mainFile: "main.typ", grantId: A_GRANT }),
      });
      const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // Peer/hostile text must not ride back (Security round 3 invariant).
        expect(res.error).not.toContain(syncUrl);
        // And never the raw hostile host fragment either.
        expect(res.error).not.toContain("evil");
        expect(res.error).not.toContain("attacker");
        expect(res.error).not.toContain("169.254");
      }
    }
  });

  it("every hostile room id is refused (no foreign capability forwarded)", async () => {
    for (let i = 0; i < HOSTILE_ROOMS.length; i++) {
      const room = HOSTILE_ROOMS[i]!;
      const seams = honestSeams({
        openProjectForControl: async (): Promise<OpenedProject> => ({ room, syncUrl: A_SYNC, mainFile: "main.typ", grantId: A_GRANT }),
      });
      const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
      expect(res.ok).toBe(false);
      // Sanity: each hostile room fails the kernel's room rule — EITHER the shape
      // regex, OR the control-room identity, OR the length cap (an over-long room
      // can match the unbounded `{16,}` regex yet is still refused by maxRoomChars).
      const passesShapeAndNotControl = KERNEL_PROJECT_ROOM_RE.test(room) && room !== CONTROL_ROOM;
      const withinLengthCap = room.length <= 128;
      expect(passesShapeAndNotControl && withinLengthCap).toBe(false);
    }
  });

  it("every hostile mainFile path is refused", async () => {
    for (let i = 0; i < HOSTILE_PATHS.length; i++) {
      const mainFile = HOSTILE_PATHS[i]!;
      const seams = honestSeams({
        openProjectForControl: async (): Promise<OpenedProject> => ({ room: A_ROOM, syncUrl: A_SYNC, mainFile, grantId: A_GRANT }),
      });
      const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
      expect(res.ok).toBe(false);
    }
  });

  it("a successful open_project ONLY ever emits the kernel-valid handoff shape", async () => {
    // Sweep valid combinations: the success path must always echo the REQUESTED
    // projectId and a room/syncUrl/path that re-pass the kernel rules.
    const validSyncs = [A_SYNC, "ws://localhost:9000", "ws://127.0.0.5:1", "wss://[::1]:443"];
    for (let i = 0; i < 200; i++) {
      const syncUrl = validSyncs[i % validSyncs.length]!;
      const room = `share-${"a".repeat(16 + (i % 40))}`;
      const seams = honestSeams({
        configuredSyncUrl: syncUrl,
        openProjectForControl: async (): Promise<OpenedProject> => ({ room, syncUrl, mainFile: "main.typ", grantId: A_GRANT }),
      });
      const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }, `c-${i}`), seams);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const r = res.result as { syncUrl: string; room: string; projectId: string; mainFile: string };
        expect(r.projectId).toBe("proj-1"); // always the REQUESTED id, never seam-claimed
        expect(KERNEL_PROJECT_ROOM_RE.test(r.room)).toBe(true);
        expect(/^wss?:\/\//.test(r.syncUrl)).toBe(true);
        // No credentials / query / fragment ever survive into the emitted url.
        const u = new URL(r.syncUrl);
        expect(u.username).toBe("");
        expect(u.search).toBe("");
        expect(u.hash).toBe("");
      }
    }
  });
});

describe("control-responder core — fuzz: structured refusal text is always bounded & seam-owned", () => {
  it("any seam refusal string (incl. oversized / hostile-looking) is truncated to the cap", async () => {
    for (let i = 0; i < 64; i++) {
      // Deterministically vary length around the cap and content.
      const len = i % 2 === 0 ? OPEN_REFUSAL_MAX_CHARS + i * 50 : i;
      const refused = "R".repeat(len);
      const seams = honestSeams({
        openProjectForControl: async (): Promise<OpenProjectRefusal> => ({ refused }),
      });
      const res = await answerControlRequest(req("open_project", { projectId: "x" }), seams);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.length).toBeLessThanOrEqual(OPEN_REFUSAL_MAX_CHARS);
    }
  });
});

describe("control-responder core — fuzz: list_* never leak non-contract fields at scale", () => {
  it("list_projects strips every extra field across a deterministic seam sweep", async () => {
    for (let i = 0; i < 50; i++) {
      const seams = honestSeams({
        listProjects: async () =>
          Array.from({ length: (i % 5) + 1 }, (_, j) => ({
            projectId: `p${j}`,
            name: `n${j}`,
            lastModified: j,
            // Hostile extra fields that must be stripped (no file contents ride along).
            secretBody: `FILE-CONTENTS-${i}-${j}`,
            ownerEmail: `leak-${i}@x`,
          })) as never,
      });
      const res = await answerControlRequest(req("list_projects"), seams);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const strings = allStrings(res.result);
        expect(strings.some((s) => s.startsWith("FILE-CONTENTS"))).toBe(false);
        expect(strings.some((s) => s.startsWith("leak-"))).toBe(false);
      }
    }
  });
});
