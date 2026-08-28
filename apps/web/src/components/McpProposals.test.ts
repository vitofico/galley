import { describe, expect, it } from "vitest";
import type { ProposalRecord, ProjectFileSnapshot } from "@galley/collab";
import {
  MAX_RENDERED_PROPOSALS,
  visibleProposals,
  findProposalTarget,
} from "./McpProposals.js";

function proposal(id: string): ProposalRecord {
  return {
    id,
    filePath: "/main.typ",
    baseText: "a",
    proposedText: "b",
    blocks: [{ search: "a", replace: "b" }],
    request: id,
    author: "mcp",
    status: "pending",
    createdAt: 0,
    seq: 0,
  };
}

function file(fileId: string, path: string, deleted = false): ProjectFileSnapshot {
  return { fileId, path, text: `text of ${fileId}`, deleted };
}

describe("visibleProposals — the render cap (Security-Analyst finding 1)", () => {
  it("renders everything while at or under the cap", () => {
    const list = [proposal("p1"), proposal("p2")];
    expect(visibleProposals(list)).toEqual({ shown: list, hidden: 0 });
  });

  it("over the cap, shows only the NEWEST cap-many and counts the hidden rest", () => {
    const list = Array.from({ length: MAX_RENDERED_PROPOSALS + 3 }, (_, i) => proposal(`p${i}`));
    const { shown, hidden } = visibleProposals(list);
    expect(shown).toHaveLength(MAX_RENDERED_PROPOSALS);
    expect(hidden).toBe(3);
    // The list arrives oldest-first; the tail (newest) is what renders.
    expect(shown.map((p) => p.id)).toEqual(
      list.slice(-MAX_RENDERED_PROPOSALS).map((p) => p.id),
    );
  });
});

describe("findProposalTarget — strict single-match Accept (Security-Analyst finding 3)", () => {
  it("resolves exactly one live file by path (deleted files ignored)", () => {
    const files = [file("f1", "/main.typ"), file("f2", "/main.typ", true), file("f3", "/x.typ")];
    expect(findProposalTarget(files, "/main.typ")).toEqual({ ok: true, file: files[0] });
  });

  it("blocks when the path is gone (no live match)", () => {
    const files = [file("f1", "/main.typ", true), file("f2", "/x.typ")];
    expect(findProposalTarget(files, "/main.typ")).toEqual({
      ok: false,
      reason: "missing",
      count: 0,
    });
  });

  it("blocks when the path is AMBIGUOUS (duplicate-path CRDT conflict) — never guesses a winner", () => {
    const files = [file("f1", "/main.typ"), file("f2", "/main.typ"), file("f3", "/x.typ")];
    expect(findProposalTarget(files, "/main.typ")).toEqual({
      ok: false,
      reason: "duplicate",
      count: 2,
    });
  });
});
