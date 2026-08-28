import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { Author, ProjectInput, CheckResult } from "@galley/shared";
import { CollabProject } from "@galley/collab";
import { detectStyleability, type Style } from "./style-manifest.js";
import { buildStyleSource, applyStyle, trialCompileStyle } from "./apply-style.js";

const human: Author = { kind: "human", userId: "u1" };

/** A deterministic id generator for tests (`f1`, `f2`, … by prefix). */
function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/** The canonical-ABI fixture style: entry `doc(body, ..extra)`, tokens accent/ink/ink-soft/rule. */
const STYLE_TEXT =
  "#let accent = red\n#let ink = black\n#let ink-soft = gray\n#let rule = silver\n#let doc(body, ..extra) = body";

const style: Style = {
  manifest: { id: "x", name: "X", abiVersion: 1, entry: "doc", tokens: ["accent", "ink", "ink-soft", "rule"], capabilities: [], builtin: true },
  files: [{ path: "/style.typ", text: STYLE_TEXT }],
  entryFile: "/style.typ",
};

/** A main that imports the canonical `doc` (clean — no shim needed). */
const CLEAN_MAIN = '#import "/style.typ": doc, accent, ink\n#show: doc.with()\n= Hi';
/** A main whose entry alias is `paper` and uses a legacy token alias (needs a shim). */
const SHIMMED_MAIN = '#import "/style.typ": paper, line-strong\n#show: paper.with()\n= Hi';

/** A project with /main.typ (main) + /style.typ. */
function projectWithStyle(mainText: string): CollabProject {
  const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
  p.create("/main.typ", mainText, human);
  p.create("/style.typ", "#let doc(body, ..extra) = body", human);
  return p;
}

describe("buildStyleSource", () => {
  it("appends a compatibility shim for a doc that needs one (entry alias + token alias)", () => {
    const styleability = detectStyleability(SHIMMED_MAIN);
    expect(styleability.state).toBe("shimmed");
    const out = buildStyleSource(style, styleability);
    expect(out.startsWith(STYLE_TEXT)).toBe(true);
    expect(out).toContain("#let paper = doc");
    expect(out).toContain("#let line-strong = rule");
    expect(out).toContain("generated compatibility shim");
  });

  it("does NOT append a shim for a clean doc (canonical entry + tokens)", () => {
    const styleability = detectStyleability(CLEAN_MAIN);
    expect(styleability.state).toBe("clean");
    const out = buildStyleSource(style, styleability);
    expect(out).toBe(STYLE_TEXT);
    expect(out).not.toContain("shim");
  });
});

describe("applyStyle", () => {
  it("replaces /style.typ, leaves /main.typ byte-identical, and adds/removes no files", () => {
    const p = projectWithStyle(CLEAN_MAIN);
    const before = p.snapshot();
    const liveBefore = before.files.filter((f) => !f.deleted).length;
    const mainBefore = before.files.find((f) => f.path === "/main.typ")!.text;

    applyStyle(p, style, detectStyleability(CLEAN_MAIN), human);

    const after = p.snapshot();
    const liveAfter = after.files.filter((f) => !f.deleted).length;
    expect(liveAfter).toBe(liveBefore);
    expect(after.files.find((f) => f.path === "/main.typ")!.text).toBe(mainBefore);
    expect(after.files.find((f) => f.path === "/style.typ")!.text).toBe(STYLE_TEXT);
  });

  it("creates /style.typ when the project lacks one", () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    p.create("/main.typ", CLEAN_MAIN, human);
    expect(p.snapshot().files.some((f) => f.path === "/style.typ")).toBe(false);

    applyStyle(p, style, detectStyleability(CLEAN_MAIN), human);

    const style0 = p.snapshot().files.find((f) => f.path === "/style.typ" && !f.deleted);
    expect(style0).toBeDefined();
    expect(style0!.text).toBe(STYLE_TEXT);
  });
});

describe("trialCompileStyle", () => {
  it("returns error diagnostics from the injected check and filters out warnings", async () => {
    const p = projectWithStyle(CLEAN_MAIN);
    const fakeCheck = async (input: ProjectInput): Promise<CheckResult> => {
      // Sanity: the candidate carries the swapped /style.typ source.
      expect(input.files.find((f) => f.path === "/style.typ")!.text).toBe(STYLE_TEXT);
      return {
        ok: false,
        diagnostics: [
          { severity: "warning", message: "a benign warning" },
          { severity: "error", message: "boom" },
        ],
        pageCount: null,
        durationMs: 1,
      };
    };

    const errors = await trialCompileStyle(p, style, detectStyleability(CLEAN_MAIN), fakeCheck);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("boom");
  });

  it("returns a single error when the project has no compilable main file", async () => {
    const p = new CollabProject(new Y.Doc(), { newId: ids("f") });
    // No files at all → no main → not compilable; check must NOT be invoked.
    let called = false;
    const errors = await trialCompileStyle(p, style, detectStyleability(CLEAN_MAIN), async () => {
      called = true;
      return { ok: true, diagnostics: [], pageCount: 1, durationMs: 1 };
    });
    expect(called).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
  });
});
