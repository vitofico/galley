import { describe, it, expect } from "vitest";
import type { Diagnostic, SourceSpan } from "@galley/shared";
import type {
  LanguageModelClient,
  ModelStep,
  ModelTextDelta,
  ModelTurnInput,
} from "@galley/agent";
import { explainAvailable, explainForDiagnostic, adviceOnlyModel } from "./explain-error.js";

/**
 * Unit tests for the explain-error helpers (roadmap #18.4).
 *
 * Two pure pieces:
 *   - `explainForDiagnostic` builds a SCOPED, advice-only agent request from a
 *     diagnostic (mirrors the #11.4b quick-fix payload builder, but asks for a
 *     plain-language explanation and explicitly forbids edits).
 *   - `adviceOnlyModel` is the HARD no-edit guard: a model wrapper that strips
 *     `propose_edit` tool calls from every step, so an explain run can never
 *     mutate the scratch even if the model misbehaves.
 */

/** Build a SourceSpan from a source string and a substring to locate. */
function spanFor(source: string, needle: string): SourceSpan {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`needle not found: ${needle}`);
  const endOffset = offset + needle.length;
  const posAt = (idx: number) => {
    const before = source.slice(0, idx);
    const line = before.split("\n").length;
    const lastNl = before.lastIndexOf("\n");
    const column = idx - lastNl; // 1-based: char after the newline is col 1
    return { line, column };
  };
  return {
    offset,
    endOffset,
    start: posAt(offset),
    end: posAt(endOffset),
  };
}

const SOURCE = [
  "= Title",
  "",
  "Some intro paragraph.",
  "#let x = unknownfn(3)",
  "More text below.",
  "Even more context lines here.",
  "Final line.",
].join("\n");

describe("explainAvailable", () => {
  it("is true when the diagnostic has a span", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
    };
    expect(explainAvailable(diag)).toBe(true);
  });

  it("is false when the diagnostic has no span", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "missing main file",
    };
    expect(explainAvailable(diag)).toBe(false);
  });
});

describe("explainForDiagnostic", () => {
  const diag: Diagnostic = {
    severity: "error",
    message: "unknown function `unknownfn`",
    span: spanFor(SOURCE, "unknownfn"),
  };

  it("builds a non-empty request quoting the message", () => {
    const explain = explainForDiagnostic(diag, SOURCE);
    expect(typeof explain.request).toBe("string");
    expect(explain.request).toContain("unknown function `unknownfn`");
  });

  it("asks for an explanation, not a fix", () => {
    const explain = explainForDiagnostic(diag, SOURCE);
    expect(explain.request.toLowerCase()).toContain("explain");
  });

  it("quotes the line/column from the span", () => {
    const span = diag.span!;
    const explain = explainForDiagnostic(diag, SOURCE);
    expect(explain.request).toContain(`line ${span.start.line}, column ${span.start.column}`);
  });

  it("includes the spanned snippet in the request and contextSnippet", () => {
    const explain = explainForDiagnostic(diag, SOURCE);
    expect(explain.contextSnippet).toContain("#let x = unknownfn(3)");
    expect(explain.request).toContain("#let x = unknownfn(3)");
  });

  it("includes compiler hints when present", () => {
    const withHints: Diagnostic = { ...diag, hints: ["did you mean `unknown`?"] };
    const explain = explainForDiagnostic(withHints, SOURCE);
    expect(explain.request).toContain("did you mean `unknown`?");
  });

  it("forbids edits: the request says not to modify the document or call propose_edit", () => {
    const explain = explainForDiagnostic(diag, SOURCE);
    expect(explain.request).toContain("Do NOT edit the document");
    expect(explain.request).toContain("do NOT call propose_edit");
  });

  it("respects contextLines", () => {
    const few = explainForDiagnostic(diag, SOURCE, { contextLines: 0 });
    const many = explainForDiagnostic(diag, SOURCE, { contextLines: 3 });
    expect(few.contextSnippet).toBe("#let x = unknownfn(3)");
    expect(few.contextSnippet.split("\n").length).toBeLessThan(
      many.contextSnippet.split("\n").length,
    );
  });

  it("returns the original diagnostic unchanged", () => {
    const explain = explainForDiagnostic(diag, SOURCE);
    expect(explain.diagnostic).toBe(diag);
  });

  it("stays total without a span: location-free request, empty snippet", () => {
    const spanless: Diagnostic = { severity: "error", message: "missing main file" };
    const explain = explainForDiagnostic(spanless, SOURCE);
    expect(explain.contextSnippet).toBe("");
    expect(explain.request).toContain("missing main file");
  });
});

// ---------------------------------------------------------------------------
// adviceOnlyModel — the hard no-edit guard.
// ---------------------------------------------------------------------------

const TURN: ModelTurnInput = { system: "sys", messages: [], tools: [] };

/** A scripted fake model whose single step mixes read/compile/propose calls. */
function fakeModel(step: ModelStep, opts?: { streaming?: boolean }): LanguageModelClient {
  const client: LanguageModelClient = {
    config: {
      kind: "openai-compatible",
      label: "Fake",
      baseUrl: "fake://",
      model: "fake",
      isLocal: true,
      transport: { mode: "direct" },
    },
    async probe() {
      return {
        reachable: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImageInput: false,
      };
    },
    async step() {
      return step;
    },
  };
  if (opts?.streaming) {
    client.stepStream = async function* (): AsyncGenerator<ModelTextDelta, ModelStep, void> {
      yield { type: "text-delta", text: step.text.slice(0, 4) };
      yield { type: "text-delta", text: step.text.slice(4) };
      return step;
    };
  }
  return client;
}

describe("adviceOnlyModel (no-edit guard)", () => {
  it("strips propose_edit calls from step() but keeps other tools", async () => {
    const inner = fakeModel({
      text: "Looking…",
      toolCalls: [
        { id: "1", name: "read_document", args: {} },
        { id: "2", name: "propose_edit", args: { edits: [{ search: "a", replace: "b" }] } },
        { id: "3", name: "compile", args: {} },
      ],
    });
    const guarded = adviceOnlyModel(inner);
    const step = await guarded.step(TURN);
    expect(step.text).toBe("Looking…");
    expect(step.toolCalls.map((t) => t.name)).toEqual(["read_document", "compile"]);
  });

  it("strips propose_edit from the final step of stepStream() and preserves deltas", async () => {
    const inner = fakeModel(
      {
        text: "Explained.",
        toolCalls: [{ id: "1", name: "propose_edit", args: { edits: [] } }],
      },
      { streaming: true },
    );
    const guarded = adviceOnlyModel(inner);
    const gen = guarded.stepStream!(TURN);
    const deltas: string[] = [];
    let next = await gen.next();
    while (!next.done) {
      deltas.push(next.value.text);
      next = await gen.next();
    }
    expect(deltas.join("")).toBe("Explained.");
    expect(next.value.toolCalls).toEqual([]);
  });

  it("does not expose stepStream when the inner model lacks it", () => {
    const inner = fakeModel({ text: "", toolCalls: [] });
    const guarded = adviceOnlyModel(inner);
    expect(guarded.stepStream).toBeUndefined();
  });

  it("passes config and probe through unchanged", async () => {
    const inner = fakeModel({ text: "", toolCalls: [] });
    const guarded = adviceOnlyModel(inner);
    expect(guarded.config).toBe(inner.config);
    await expect(guarded.probe()).resolves.toEqual(await inner.probe());
  });
});
