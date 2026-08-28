import { describe, it, expect } from "vitest";
import type { ControlRequest } from "@galley/collab";
import {
  answerControlRequest,
  answerCreateProjectRequest,
  createControlResponder,
  MAX_CREATE_PROJECT_NAME_CHARS,
  OPEN_REFUSAL_MAX_CHARS,
  VERSION_FILE_TEXT_MAX_CHARS,
  type ControlResponderSeams,
} from "./control-responder.js";

/**
 * NOTE (typecheck-poison guard, per the lane contract): this test lives in
 * apps/web and MUST NOT import from apps/mcp/** — that would pull MCP/server
 * deps into the web typecheck. The kernel's acceptance rules are mirrored here
 * INLINE so the responder is asserted correct-by-construction against the same
 * posture the kernel enforces (apps/mcp/src/control-tools.ts).
 */

// The kernel's room rule (control-tools.ts PROJECT_ROOM_RE), mirrored for assertion.
const KERNEL_PROJECT_ROOM_RE = /^share-[A-Za-z0-9-]{16,}$/;

const A_ROOM = "share-11112222333344445555"; // satisfies the kernel rule
const A_SYNC = "ws://127.0.0.1:1234";
const CONTROL_ROOM = "share-controlcontrolcontrol";
const A_GRANT = "g0aBcDeF1234_-ZyXwVu"; // a base64url-shaped per-grant token

function req(op: string, params: Record<string, unknown> = {}): ControlRequest {
  return { id: "id-abcdef123456", op, params, createdAt: 1 };
}

/** A baseline of honest seams; individual tests override one field. */
function honestSeams(over: Partial<ControlResponderSeams> = {}): ControlResponderSeams {
  return {
    configuredSyncUrl: A_SYNC,
    controlRoom: CONTROL_ROOM,
    listProjects: async () => [
      { projectId: "proj-1", name: "Alpha", lastModified: 100 },
      { projectId: "proj-2", name: "Beta" },
    ],
    listVersions: async (projectId) =>
      projectId === "proj-1"
        ? [{ id: "v1", name: "Draft", message: "first", createdAt: 5 }]
        : null,
    createProject: async (name) => ({ projectId: "proj-new", name }),
    openProjectForControl: async (projectId) =>
      projectId === "proj-1"
        ? { room: A_ROOM, syncUrl: A_SYNC, mainFile: "main.typ", grantId: A_GRANT }
        : null,
    versionTree: async (projectId, versionId) =>
      projectId === "proj-1" && versionId === "v1"
        ? [
            { path: "/main.typ", text: "= Title\nBody" },
            { path: "/chapters/one.typ", text: "Chapter one" },
          ]
        : null,
    ...over,
  };
}

/** Recursively collect every string value in a payload (for "no file contents" checks). */
function allStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, acc);
  else if (value && typeof value === "object") for (const v of Object.values(value)) allStrings(v, acc);
  return acc;
}

describe("answerControlRequest — list_projects", () => {
  it("maps the seam result to {projectId, name, lastModified?}", async () => {
    const res = await answerControlRequest(req("list_projects"), honestSeams());
    expect(res).toEqual({
      id: "id-abcdef123456",
      ok: true,
      result: [
        { projectId: "proj-1", name: "Alpha", lastModified: 100 },
        { projectId: "proj-2", name: "Beta" },
      ],
    });
  });

  it("omits lastModified when absent (no undefined leak)", async () => {
    const res = await answerControlRequest(req("list_projects"), honestSeams());
    expect(res.ok).toBe(true);
    if (res.ok) {
      const second = (res.result as Record<string, unknown>[])[1]!;
      expect("lastModified" in second).toBe(false);
    }
  });

  it("drops extra seam fields — only the contract picks are emitted", async () => {
    const seams = honestSeams({
      listProjects: async () => [
        { projectId: "p", name: "n", lastModified: 1, secretBody: "FILE CONTENTS" } as never,
      ],
    });
    const res = await answerControlRequest(req("list_projects"), seams);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(allStrings(res.result)).not.toContain("FILE CONTENTS");
      expect(res.result).toEqual([{ projectId: "p", name: "n", lastModified: 1 }]);
    }
  });

  it("clamps to the kernel's project-entry cap (200)", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ projectId: `p${i}`, name: `n${i}` }));
    const res = await answerControlRequest(req("list_projects"), honestSeams({ listProjects: async () => many }));
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as unknown[]).length).toBe(200);
  });
});

describe("answerControlRequest — list_versions", () => {
  it("returns metadata-only list for a known project", async () => {
    const res = await answerControlRequest(req("list_versions", { projectId: "proj-1" }), honestSeams());
    expect(res).toEqual({
      id: "id-abcdef123456",
      ok: true,
      result: [{ id: "v1", name: "Draft", message: "first", createdAt: 5 }],
    });
  });

  it("unknown project (seam returns null) → ok:false", async () => {
    const res = await answerControlRequest(req("list_versions", { projectId: "nope" }), honestSeams());
    expect(res.ok).toBe(false);
  });

  it("missing projectId param → ok:false (no seam call needed)", async () => {
    const res = await answerControlRequest(req("list_versions", {}), honestSeams());
    expect(res.ok).toBe(false);
  });

  it("never emits version file contents (only metadata picks)", async () => {
    const seams = honestSeams({
      listVersions: async () => [
        { id: "v1", name: "n", message: "m", createdAt: 1, files: { "a.typ": "BODY" } } as never,
      ],
    });
    const res = await answerControlRequest(req("list_versions", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(allStrings(res.result)).not.toContain("BODY");
      expect(res.result).toEqual([{ id: "v1", name: "n", message: "m", createdAt: 1 }]);
    }
  });

  it("clamps to the kernel's version-entry cap (200)", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `v${i}`, name: `n${i}` }));
    const res = await answerControlRequest(
      req("list_versions", { projectId: "proj-1" }),
      honestSeams({ listVersions: async () => many }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as unknown[]).length).toBe(200);
  });
});

describe("answerCreateProjectRequest / create_project op (F1)", () => {
  it("returns {ok:true, result:{projectId, name}} and calls the seam with the name", async () => {
    const seen: string[] = [];
    const createProject = async (name: string): Promise<{ projectId: string; name: string }> => {
      seen.push(name);
      return { projectId: "proj-1", name: "Hello" };
    };
    const res = await answerControlRequest(
      req("create_project", { name: "Hello" }),
      honestSeams({ createProject }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ projectId: "proj-1", name: "Hello" });
    expect(seen).toEqual(["Hello"]);
  });

  it("refuses a missing name param with /requires a name/ and NO seam call", async () => {
    let called = false;
    const createProject = async (name: string): Promise<{ projectId: string; name: string }> => {
      called = true;
      return { projectId: "proj-1", name };
    };
    const res = await answerCreateProjectRequest(req("create_project", {}), createProject);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/requires a name/);
    expect(called).toBe(false);
  });

  it("refuses an over-length name with /too long/ and NO seam call", async () => {
    let called = false;
    const createProject = async (name: string): Promise<{ projectId: string; name: string }> => {
      called = true;
      return { projectId: "proj-1", name };
    };
    const tooLong = "x".repeat(MAX_CREATE_PROJECT_NAME_CHARS + 1);
    const res = await answerCreateProjectRequest(
      req("create_project", { name: tooLong }),
      createProject,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too long/);
    expect(called).toBe(false);
  });

  it("fail-closes a throwing seam to the generic 'could not complete' message (never throws)", async () => {
    const createProject = async (): Promise<{ projectId: string; name: string }> => {
      throw new Error("idb exploded");
    };
    const res = await answerCreateProjectRequest(
      req("create_project", { name: "Hello" }),
      createProject,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not complete/);
  });

  it("keeps MAX_CREATE_PROJECT_NAME_CHARS in lockstep with the kernel's maxNameChars (500)", () => {
    // The kernel's CONTROL_TOOL_LIMITS.maxNameChars is 500; mirrored here (apps/web
    // must not import apps/mcp). If the kernel cap changes, update both.
    expect(MAX_CREATE_PROJECT_NAME_CHARS).toBe(500);
  });
});

describe("answerControlRequest — list_version_files (B4)", () => {
  it("returns {path, size} for every file in the named version, sizes in code units", async () => {
    const res = await answerControlRequest(
      req("list_version_files", { projectId: "proj-1", versionId: "v1" }),
      honestSeams(),
    );
    expect(res).toEqual({
      id: "id-abcdef123456",
      ok: true,
      result: {
        files: [
          { path: "/main.typ", size: "= Title\nBody".length },
          { path: "/chapters/one.typ", size: "Chapter one".length },
        ],
        truncated: false,
      },
    });
  });

  it("never emits the file TEXT — only path + size", async () => {
    const res = await answerControlRequest(
      req("list_version_files", { projectId: "proj-1", versionId: "v1" }),
      honestSeams(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(allStrings(res.result)).not.toContain("= Title\nBody");
      expect(allStrings(res.result)).not.toContain("Chapter one");
    }
  });

  it("unknown project/version (seam null) → ok:false", async () => {
    const res = await answerControlRequest(
      req("list_version_files", { projectId: "proj-1", versionId: "nope" }),
      honestSeams(),
    );
    expect(res.ok).toBe(false);
  });

  it("missing projectId or versionId → ok:false (no seam call)", async () => {
    expect((await answerControlRequest(req("list_version_files", { versionId: "v1" }), honestSeams())).ok).toBe(false);
    expect((await answerControlRequest(req("list_version_files", { projectId: "proj-1" }), honestSeams())).ok).toBe(false);
  });

  it("clamps to the version-file entry cap (200)", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ path: `/f${i}.typ`, text: "x" }));
    const res = await answerControlRequest(
      req("list_version_files", { projectId: "proj-1", versionId: "v1" }),
      honestSeams({ versionTree: async () => many }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { files: unknown[]; truncated: boolean };
      expect(r.files.length).toBe(200);
      expect(r.truncated).toBe(true);
    }
  });
});

describe("answerControlRequest — read_version_file (B4)", () => {
  it("returns the file's text at that version", async () => {
    const res = await answerControlRequest(
      req("read_version_file", { projectId: "proj-1", versionId: "v1", path: "/main.typ" }),
      honestSeams(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ text: "= Title\nBody" });
  });

  it("tolerates a path missing its leading slash (canonicalized before lookup)", async () => {
    const res = await answerControlRequest(
      req("read_version_file", { projectId: "proj-1", versionId: "v1", path: "main.typ" }),
      honestSeams(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ text: "= Title\nBody" });
  });

  it("unknown file path in a known version → ok:false (not found)", async () => {
    const res = await answerControlRequest(
      req("read_version_file", { projectId: "proj-1", versionId: "v1", path: "/missing.typ" }),
      honestSeams(),
    );
    expect(res.ok).toBe(false);
  });

  it("unsafe path (traversal) → ok:false, no seam lookup leaked", async () => {
    const res = await answerControlRequest(
      req("read_version_file", { projectId: "proj-1", versionId: "v1", path: "/../escape.typ" }),
      honestSeams(),
    );
    expect(res.ok).toBe(false);
  });

  it("missing any of projectId/versionId/path → ok:false", async () => {
    expect((await answerControlRequest(req("read_version_file", { versionId: "v1", path: "/main.typ" }), honestSeams())).ok).toBe(false);
    expect((await answerControlRequest(req("read_version_file", { projectId: "proj-1", path: "/main.typ" }), honestSeams())).ok).toBe(false);
    expect((await answerControlRequest(req("read_version_file", { projectId: "proj-1", versionId: "v1" }), honestSeams())).ok).toBe(false);
  });

  it("unknown project/version → ok:false", async () => {
    const res = await answerControlRequest(
      req("read_version_file", { projectId: "proj-1", versionId: "nope", path: "/main.typ" }),
      honestSeams(),
    );
    expect(res.ok).toBe(false);
  });

  it("oversized file → structured ok:false refusal (never the bytes)", async () => {
    const huge = "x".repeat(VERSION_FILE_TEXT_MAX_CHARS + 1);
    const res = await answerControlRequest(
      req("read_version_file", { projectId: "proj-1", versionId: "v1", path: "/big.typ" }),
      honestSeams({ versionTree: async () => [{ path: "/big.typ", text: huge }] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/too large|exceeds/i);
      // The bytes never ride back in the refusal.
      expect(res.error).not.toContain(huge);
    }
  });

  it("a file exactly at the cap is returned (boundary)", async () => {
    const atCap = "y".repeat(VERSION_FILE_TEXT_MAX_CHARS);
    const res = await answerControlRequest(
      req("read_version_file", { projectId: "proj-1", versionId: "v1", path: "/edge.typ" }),
      honestSeams({ versionTree: async () => [{ path: "/edge.typ", text: atCap }] }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ text: atCap });
  });
});

describe("answerControlRequest — open_project", () => {
  it("happy path → ok:{syncUrl, room, projectId (echoed), mainFile, grantId}", async () => {
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), honestSeams());
    expect(res).toEqual({
      id: "id-abcdef123456",
      ok: true,
      result: {
        syncUrl: A_SYNC,
        room: A_ROOM,
        projectId: "proj-1",
        mainFile: "main.typ",
        grantId: A_GRANT,
      },
    });
  });

  it("echoes the REQUESTED projectId even if the seam tried a different one", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({
        room: A_ROOM,
        syncUrl: A_SYNC,
        mainFile: "main.typ",
        grantId: A_GRANT,
      }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { projectId: string }).projectId).toBe("proj-1");
  });

  it("echoes a valid grantId", async () => {
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), honestSeams());
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { grantId: string }).grantId).toBe(A_GRANT);
  });

  it.each([
    ["empty", ""],
    ["oversized", "a".repeat(129)],
    ["bad charset (space)", "has a space"],
    ["bad charset (slash)", "has/slash"],
  ])("refuses a %s grantId → ok:false, does NOT forward it", async (_name, grantId) => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: A_SYNC, mainFile: "main.typ", grantId }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/grantId/);
  });

  it("unknown project (seam returns null) → ok:false", async () => {
    const res = await answerControlRequest(req("open_project", { projectId: "nope" }), honestSeams());
    expect(res.ok).toBe(false);
  });

  it("missing projectId param → ok:false", async () => {
    const res = await answerControlRequest(req("open_project", {}), honestSeams());
    expect(res.ok).toBe(false);
  });

  it("seam returns a BAD room id → ok:false, does NOT forward it", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: "proj-1", syncUrl: A_SYNC, mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
    expect(KERNEL_PROJECT_ROOM_RE.test("proj-1")).toBe(false); // sanity: the kernel would reject it too
  });

  it("seam returns the control room as the project room → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: CONTROL_ROOM, syncUrl: A_SYNC, mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("seam returns a bad syncUrl (with credentials) → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: "ws://user:pass@127.0.0.1:1234", mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("seam returns a foreign-relay syncUrl → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: "ws://evil.example:1234", mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("seam returns a syncUrl with a query/fragment → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: "ws://127.0.0.1:1234/?x=1", mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("seam returns a non-ws syncUrl → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: "http://127.0.0.1:1234", mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("accepts the exact configured relay even when not loopback", async () => {
    const relay = "wss://relay.example.com/sync";
    const seams = honestSeams({
      configuredSyncUrl: relay,
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: relay, mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(true);
  });

  it("seam returns an unsafe mainFile path → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: A_SYNC, mainFile: "../escape.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("seam returns an empty mainFile → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: A_SYNC, mainFile: "", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("seam returns a structured {refused} → ok:false carrying that exact reason", async () => {
    const reason = "only the currently-open project can be shared with the agent right now";
    const seams = honestSeams({
      openProjectForControl: async () => ({ refused: reason }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "other" }), seams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(reason);
  });

  it("null (unknown project) still maps to the generic 'unknown project' — distinct from {refused}", async () => {
    const seams = honestSeams({ openProjectForControl: async () => null });
    const res = await answerControlRequest(req("open_project", { projectId: "nope" }), seams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("unknown project");
  });

  it("a {refused} reason is TRUNCATED to the hard cap (a handler can't ship an unbounded string)", async () => {
    const huge = "x".repeat(OPEN_REFUSAL_MAX_CHARS + 500);
    const seams = honestSeams({ openProjectForControl: async () => ({ refused: huge }) });
    const res = await answerControlRequest(req("open_project", { projectId: "other" }), seams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBe(OPEN_REFUSAL_MAX_CHARS);
  });

  it("the happy path is unchanged after widening the seam (success still validates + echoes)", async () => {
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), honestSeams());
    expect(res).toEqual({
      id: "id-abcdef123456",
      ok: true,
      result: { syncUrl: A_SYNC, room: A_ROOM, projectId: "proj-1", mainFile: "main.typ", grantId: A_GRANT },
    });
  });
});

describe("answerControlRequest — fail-closed posture", () => {
  it("unknown op → ok:false", async () => {
    const res = await answerControlRequest(req("delete_everything"), honestSeams());
    expect(res.ok).toBe(false);
  });

  it("a seam that throws → ok:false, never crashes", async () => {
    const seams = honestSeams({
      listProjects: async () => {
        throw new Error("idb exploded");
      },
    });
    const res = await answerControlRequest(req("list_projects"), seams);
    expect(res.ok).toBe(false);
  });

  it("a seam that throws on open_project → ok:false", async () => {
    const seams = honestSeams({
      openProjectForControl: async () => {
        throw new Error("mint exploded");
      },
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
  });

  it("the response always carries the request id", async () => {
    const res = await answerControlRequest({ ...req("nope"), id: "correlation-xyz-123" }, honestSeams());
    expect(res.id).toBe("correlation-xyz-123");
  });

  it("an ok:false error never quotes the offered foreign URL (no peer text leak)", async () => {
    const offered = "ws://evil.attacker.example:9999";
    const seams = honestSeams({
      openProjectForControl: async () => ({ room: A_ROOM, syncUrl: offered, mainFile: "main.typ", grantId: A_GRANT }),
    });
    const res = await answerControlRequest(req("open_project", { projectId: "proj-1" }), seams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toContain(offered);
  });
});

describe("createControlResponder — per-request answerer", () => {
  it("binds the seams once and answers many requests", async () => {
    const answer = createControlResponder(honestSeams());
    const a = await answer(req("list_projects"));
    const b = await answer(req("list_versions", { projectId: "proj-1" }));
    const c = await answer(req("open_project", { projectId: "proj-1" }));
    expect(a.ok && b.ok && c.ok).toBe(true);
  });
});

import {
  answerExportCompiledRequest,
  exportCompiledOps,
  EXPORT_COMPILED_MAX_BYTES,
  EXPORT_COMPILED_MIME,
  type ExportCompiledSeam,
} from "./control-responder.js";

describe("answerExportCompiledRequest (A1) — the pure core", () => {
  const HASH = "c".repeat(64);
  const okSeam: ExportCompiledSeam = async () => ({ hash: HASH, size: 1234 });

  it("lists export_compiled as its op", () => {
    expect(exportCompiledOps()).toEqual(["export_compiled"]);
  });

  it("shapes the signed descriptor {transferId, hash, size, mime} on success", async () => {
    const res = await answerExportCompiledRequest(
      req("export_compiled", { projectId: "proj-1", transferId: "t-1", maxBytes: 1024 * 1024 }),
      okSeam,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toEqual({ transferId: "t-1", hash: HASH, size: 1234, mime: EXPORT_COMPILED_MIME });
    }
  });

  it("clamps maxBytes to the responder ceiling before calling the seam", async () => {
    let seenMax = -1;
    const seam: ExportCompiledSeam = async (_p, _t, maxBytes) => {
      seenMax = maxBytes;
      return { hash: HASH, size: 1 };
    };
    await answerExportCompiledRequest(
      req("export_compiled", { projectId: "p", transferId: "t", maxBytes: EXPORT_COMPILED_MAX_BYTES * 4 }),
      seam,
    );
    expect(seenMax).toBe(EXPORT_COMPILED_MAX_BYTES);
  });

  it.each([
    [{ transferId: "t", maxBytes: 10 }, /projectId/], // no projectId
    [{ projectId: "p", maxBytes: 10 }, /transferId/], // no transferId
    [{ projectId: "p", transferId: "t" }, /maxBytes/], // no maxBytes
    [{ projectId: "p", transferId: "t", maxBytes: 0 }, /maxBytes/], // non-positive
    [{ projectId: "p", transferId: "t", maxBytes: 1.5 }, /maxBytes/], // non-integer
    [{ projectId: "p", transferId: "x".repeat(65), maxBytes: 10 }, /transferId is too long/],
  ])("refuses a bad param set %j with NO seam call", async (params, want) => {
    let called = false;
    const seam: ExportCompiledSeam = async () => {
      called = true;
      return { hash: HASH, size: 1 };
    };
    const res = await answerExportCompiledRequest(req("export_compiled", params), seam);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(want);
    expect(called).toBe(false);
  });

  it("maps a null seam result to a generic unknown-project refusal", async () => {
    const res = await answerExportCompiledRequest(
      req("export_compiled", { projectId: "p", transferId: "t", maxBytes: 10 }),
      async () => null,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown project/);
  });

  it("forwards a (truncated) structured {refused} reason", async () => {
    const res = await answerExportCompiledRequest(
      req("export_compiled", { projectId: "p", transferId: "t", maxBytes: 10 }),
      async () => ({ refused: "x".repeat(OPEN_REFUSAL_MAX_CHARS + 50) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeLessThanOrEqual(OPEN_REFUSAL_MAX_CHARS);
  });

  it("fail-closed: a seam THROW becomes ok:false (never thrown)", async () => {
    const res = await answerExportCompiledRequest(
      req("export_compiled", { projectId: "p", transferId: "t", maxBytes: 10 }),
      async () => {
        throw new Error("boom");
      },
    );
    expect(res.ok).toBe(false);
  });
});

// --- compile (F9/F5) — relay the browser's live-preview diagnostics ----------
import {
  answerCompileRequest,
  compileOps,
  COMPILE_MAX_DIAGNOSTICS,
  COMPILE_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  type CompileSeam,
} from "./control-responder.js";

describe("answerCompileRequest (F9) — the pure core", () => {
  const okSeam: CompileSeam = async () => ({
    ok: true,
    pageCount: 2,
    diagnostics: [{ severity: "warning", message: "w" }],
  });

  it("lists compile as its op", () => {
    expect(compileOps()).toEqual(["compile"]);
  });

  it("refuses a missing projectId with NO seam call", async () => {
    let called = false;
    const seam: CompileSeam = async () => {
      called = true;
      return okSeam("p");
    };
    const res = await answerCompileRequest(req("compile", {}), seam);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/projectId/);
    expect(called).toBe(false);
  });

  it("maps a null seam result to a generic unknown-project refusal", async () => {
    const res = await answerCompileRequest(req("compile", { projectId: "p" }), async () => null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown project/);
  });

  it("forwards a (truncated) structured {refused} reason", async () => {
    const res = await answerCompileRequest(
      req("compile", { projectId: "p" }),
      async () => ({ refused: "x".repeat(OPEN_REFUSAL_MAX_CHARS + 50) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeLessThanOrEqual(OPEN_REFUSAL_MAX_CHARS);
  });

  it("emits ONLY the contract picks {ok, pageCount, diagnostics} (extra seam fields dropped)", async () => {
    const seam: CompileSeam = async () =>
      ({
        ok: false,
        pageCount: null,
        diagnostics: [{ severity: "error", message: "boom", path: "/main.typ" }],
        // a hostile/extra field the core must NOT echo:
        secret: "leak",
      }) as unknown as Awaited<ReturnType<CompileSeam>>;
    const res = await answerCompileRequest(req("compile", { projectId: "p" }), seam);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toEqual({
        ok: false,
        pageCount: null,
        diagnostics: [{ severity: "error", message: "boom", path: "/main.typ" }],
      });
    }
  });

  it("slices an oversized diagnostics array and caps each message", async () => {
    const longMessage = "z".repeat(COMPILE_DIAGNOSTIC_MESSAGE_MAX_CHARS + 500);
    const huge = Array.from({ length: COMPILE_MAX_DIAGNOSTICS + 100 }, () => ({
      severity: "warning" as const,
      message: longMessage,
    }));
    const seam: CompileSeam = async () => ({ ok: false, pageCount: null, diagnostics: huge });
    const res = await answerCompileRequest(req("compile", { projectId: "p" }), seam);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { diagnostics: { message: string }[] };
      expect(result.diagnostics).toHaveLength(COMPILE_MAX_DIAGNOSTICS);
      expect(result.diagnostics[0]!.message.length).toBe(COMPILE_DIAGNOSTIC_MESSAGE_MAX_CHARS);
    }
  });

  it("fail-closed: a seam THROW becomes a generic refusal (never thrown)", async () => {
    const res = await answerCompileRequest(req("compile", { projectId: "p" }), async () => {
      throw new Error("boom");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toMatch(/boom/);
  });
});

// --- expect_blob (A2) — reserve inbound capacity for a kernel binary push ----
import { answerExpectBlobRequest, type ExpectBlobSeam } from "./control-responder.js";

describe("answerExpectBlobRequest (A2)", () => {
  const HASH = "a".repeat(64);

  it("reserves capacity and returns {reserved:true} on a well-formed request", async () => {
    const seam: ExpectBlobSeam = async () => true;
    const res = await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: HASH, size: 100 }), seam);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ reserved: true });
  });

  it("returns {reserved:false} when the channel declines (no oracle, ok:true)", async () => {
    const seam: ExpectBlobSeam = async () => false;
    const res = await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: HASH, size: 100 }), seam);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ reserved: false });
  });

  it("refuses an unknown project (seam null)", async () => {
    const seam: ExpectBlobSeam = async () => null;
    const res = await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: HASH, size: 100 }), seam);
    expect(res.ok).toBe(false);
  });

  it("refuses a missing/ill-typed projectId, hash, or size WITHOUT calling the seam", async () => {
    let called = false;
    const seam: ExpectBlobSeam = async () => { called = true; return true; };
    expect((await answerExpectBlobRequest(req("expect_blob", { hash: HASH, size: 1 }), seam)).ok).toBe(false);
    expect((await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: "ZZ", size: 1 }), seam)).ok).toBe(false);
    expect((await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: HASH, size: 0 }), seam)).ok).toBe(false);
    expect((await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: HASH, size: -5 }), seam)).ok).toBe(false);
    expect((await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: HASH, size: 1.5 }), seam)).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("a seam THROW is a fail-closed refusal, never a throw", async () => {
    const seam: ExpectBlobSeam = async () => { throw new Error("boom"); };
    const res = await answerExpectBlobRequest(req("expect_blob", { projectId: "p1", hash: HASH, size: 1 }), seam);
    expect(res.ok).toBe(false);
  });
});

// --- release_blob (A2/C1b) — drop earlier reservations on upload failure ------
import { answerReleaseBlobRequest, type ReleaseBlobSeam } from "./control-responder.js";

describe("answerReleaseBlobRequest (A2/C1b)", () => {
  const H = "a".repeat(64);
  it("releases the given hashes and returns {released:true}", async () => {
    const calls: { hash: string; size: number }[][] = [];
    const seam: ReleaseBlobSeam = async (_pid, hashes) => { calls.push(hashes); return true; };
    const res = await answerReleaseBlobRequest(
      req("release_blob", { projectId: "p1", hashes: [{ hash: H, size: 10 }] }),
      seam,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ released: true });
    expect(calls[0]).toEqual([{ hash: H, size: 10 }]);
  });

  it("drops malformed entries but still releases the valid ones", async () => {
    let received: { hash: string; size: number }[] = [];
    const seam: ReleaseBlobSeam = async (_pid, hashes) => { received = hashes; return true; };
    const res = await answerReleaseBlobRequest(
      req("release_blob", { projectId: "p1", hashes: [{ hash: "ZZ", size: 1 }, { hash: H, size: 5 }, { hash: H, size: -1 }] }),
      seam,
    );
    expect(res.ok).toBe(true);
    expect(received).toEqual([{ hash: H, size: 5 }]);
  });

  it("refuses an empty / all-invalid / oversized hashes array", async () => {
    const seam: ReleaseBlobSeam = async () => true;
    expect((await answerReleaseBlobRequest(req("release_blob", { projectId: "p1", hashes: [] }), seam)).ok).toBe(false);
    expect((await answerReleaseBlobRequest(req("release_blob", { projectId: "p1", hashes: [{ hash: "bad", size: 1 }] }), seam)).ok).toBe(false);
    const tooMany = Array.from({ length: 65 }, () => ({ hash: H, size: 1 }));
    expect((await answerReleaseBlobRequest(req("release_blob", { projectId: "p1", hashes: tooMany }), seam)).ok).toBe(false);
  });

  it("refuses unknown project (seam null) and never throws on a seam throw", async () => {
    const nul: ReleaseBlobSeam = async () => null;
    expect((await answerReleaseBlobRequest(req("release_blob", { projectId: "p1", hashes: [{ hash: H, size: 1 }] }), nul)).ok).toBe(false);
    const boom: ReleaseBlobSeam = async () => { throw new Error("x"); };
    expect((await answerReleaseBlobRequest(req("release_blob", { projectId: "p1", hashes: [{ hash: H, size: 1 }] }), boom)).ok).toBe(false);
  });
});
