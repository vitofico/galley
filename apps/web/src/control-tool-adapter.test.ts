/**
 * Roadmap #3 — control-tool-adapter tests: the registry's READ-ONLY entries
 * answered in the control-responder envelope, mutating/unknown ops refused,
 * seam failures fail closed. The adapter is PURE and UNMOUNTED — these tests
 * are its only consumer until the security-gated activation wave.
 */
import { describe, it, expect } from "vitest";
import type { ControlRequest } from "@galley/collab";
import type { ProjectToolsSeam, ToolSeams } from "@galley/agent";
import {
  answerReadonlyToolRequest,
  createReadonlyToolResponder,
  readonlyToolOps,
} from "./control-tool-adapter.js";

function request(op: string, params: Record<string, unknown> = {}): ControlRequest {
  return { id: `req-${op}`, op, params, createdAt: 0 };
}

function fakeProjectTools(): ProjectToolsSeam {
  return {
    listFiles: () => [
      { fileId: "f1", path: "/main.typ" },
      { fileId: "f2", path: "/appendix.typ" },
    ],
    readFile: (path) => (path === "/main.typ" ? "= Intro\nbody\n" : null),
    search: (query) =>
      query === "body"
        ? { files: [{ path: "/main.typ", matches: [{ line: 2, snippet: "body" }] }], totalMatches: 1 }
        : { files: [], totalMatches: 0 },
  };
}

function seams(overrides: Partial<ToolSeams> = {}): ToolSeams {
  return {
    state: {
      scratch: "= Doc\nhello\n",
      blocks: [],
      lastCheck: null,
      lastViolations: [],
      compileIters: 0,
      failedConsecutive: 0,
    },
    compiler: {
      check: async () => ({ ok: true, diagnostics: [], pageCount: 1, durationMs: 0 }),
    },
    max: 5,
    constraints: null,
    retrieval: { active: false },
    projectTools: fakeProjectTools(),
    ...overrides,
  };
}

describe("answerReadonlyToolRequest", () => {
  it("answers read-only project ops in the control envelope", async () => {
    const list = await answerReadonlyToolRequest(request("list_files"), seams());
    expect(list.ok).toBe(true);
    if (list.ok) {
      const result = list.result as { text: string; summary: string };
      expect(result.text).toContain("/main.typ");
      expect(result.summary).toBe("2 file(s)");
    }

    const read = await answerReadonlyToolRequest(
      request("read_file", { path: "/main.typ" }),
      seams(),
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect((read.result as { text: string }).text).toContain("1| = Intro");

    const search = await answerReadonlyToolRequest(
      request("search_project", { query: "body" }),
      seams(),
    );
    expect(search.ok).toBe(true);
    if (search.ok) expect((search.result as { text: string }).text).toContain("/main.typ:2: body");
  });

  it("answers the core read-only tools (read_document / compile) too", async () => {
    const doc = await answerReadonlyToolRequest(request("read_document"), seams());
    expect(doc.ok).toBe(true);
    if (doc.ok) expect((doc.result as { text: string }).text).toContain("2| hello");

    const compile = await answerReadonlyToolRequest(request("compile"), seams());
    expect(compile.ok).toBe(true);
    if (compile.ok) {
      expect((compile.result as { text: string }).text).toContain("Compiled cleanly");
    }
  });

  it("REFUSES the mutating propose_edit — the mailbox gets no write path", async () => {
    const before = "= Doc\nhello\n";
    const s = seams();
    const res = await answerReadonlyToolRequest(
      request("propose_edit", { edits: [{ search: "hello", replace: "pwned" }] }),
      s,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("unsupported tool op: propose_edit");
    // The scratch was never touched — refusal happened before any dispatch.
    expect(s.state.scratch).toBe(before);
    expect(s.state.blocks).toEqual([]);
  });

  it("refuses unknown ops and seam-gated ops without the seam", async () => {
    const unknown = await answerReadonlyToolRequest(request("frobnicate"), seams());
    expect(unknown.ok).toBe(false);

    const bare = seams();
    delete (bare as { projectTools?: unknown }).projectTools;
    const gated = await answerReadonlyToolRequest(request("search_project", { query: "x" }), bare);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.error).toBe("tool unavailable: search_project");
  });

  it("fails closed on a throwing seam (generic error, never a leak, never a throw)", async () => {
    const s = seams({
      projectTools: {
        listFiles: () => {
          throw new Error("secret idb path leaked");
        },
        readFile: () => null,
        search: () => ({ files: [], totalMatches: 0 }),
      },
    });
    const res = await answerReadonlyToolRequest(request("list_files"), s);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("the tool could not complete this request");
      expect(res.error).not.toContain("secret");
    }
  });

  it("exposes exactly the read-only registry names as ops", () => {
    expect(readonlyToolOps()).toEqual([
      "read_document",
      "compile",
      "search_project",
      "list_files",
      "read_file",
      "list_bibliography",
    ]);
    expect(readonlyToolOps()).not.toContain("propose_edit");
  });

  it("answers list_bibliography from a .bib-bearing seam in the control envelope", async () => {
    const s = seams({
      projectTools: {
        listFiles: () => [{ fileId: "f", path: "/refs.bib" }],
        readFile: (path) =>
          path === "/refs.bib"
            ? "@article{doe2021, title={A Study}, author={Doe, Jane}, year={2021}, doi={10.1/xyz}}"
            : null,
        search: () => ({ files: [], totalMatches: 0 }),
      },
    });
    const res = await answerReadonlyToolRequest(request("list_bibliography"), s);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { text: string; summary: string };
      expect(result.text).toContain("doe2021");
      expect(result.text).toContain("A Study");
      expect(result.summary).toBe("1 entry");
    }
  });

  it("createReadonlyToolResponder binds seams once (the drain-loop shape)", async () => {
    const answer = createReadonlyToolResponder(seams());
    const res = await answer(request("list_files"));
    expect(res.ok).toBe(true);
    expect(res.id).toBe("req-list_files");
  });
});
