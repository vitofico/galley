/**
 * Roadmap #13 — cross-reference autocomplete: a COMPOSABLE CodeMirror 6
 * completion source for `@name` references.
 *
 * This is injection-only: the source takes label names via a `getLabels`
 * callback (NOT by importing labels.ts / @galley/agent — the barrel doesn't
 * export the core yet, and the coordinator owns the wiring). The tests inject
 * label names inline and drive the source through a real EditorState +
 * CompletionContext so we exercise the actual `matchBefore(/@.../)` path.
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { labelCompletionSource } from "./label-complete.js";

/** Build a CompletionContext at `pos` for the given doc (explicit=true). */
function ctxAt(doc: string, pos: number): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, pos, true);
}

function run(
  doc: string,
  pos: number,
  labels: string[],
): CompletionResult | null {
  const source = labelCompletionSource(() => labels);
  return source(ctxAt(doc, pos)) as CompletionResult | null;
}

describe("labelCompletionSource", () => {
  it("offers all known labels right after an `@`", () => {
    const res = run("see @", 5, ["intro", "method", "results"]);
    expect(res).not.toBeNull();
    expect(res!.from).toBe(5); // just past the `@`, so apply inserts the bare name
    expect(res!.options.map((o) => o.label)).toEqual([
      "intro",
      "method",
      "results",
    ]);
  });

  it("applies the bare name (caller-facing label is the name)", () => {
    const res = run("@", 1, ["fig.one"]);
    expect(res!.options[0]!.apply ?? res!.options[0]!.label).toBe("fig.one");
  });

  it("matches a partial `@in` prefix (from covers the whole token)", () => {
    const res = run("text @in", 8, ["intro", "method"]);
    expect(res).not.toBeNull();
    expect(res!.from).toBe(6); // just past the `@`; CM filters "in" against names
    expect(res!.options.map((o) => o.label)).toContain("intro");
  });

  it("supports the full label charset in the trigger token", () => {
    const res = run("@fig.a-1_b:", 11, ["fig.a-1_b:c"]);
    expect(res).not.toBeNull();
    expect(res!.from).toBe(1); // just past the leading `@`
  });

  it("yields nothing when there is no `@` token before the cursor", () => {
    expect(run("plain text", 10, ["intro"])).toBeNull();
  });

  it("yields nothing for an explicit invocation mid-word (no `@`)", () => {
    expect(run("introd", 6, ["intro"])).toBeNull();
  });

  it("returns an empty option list when there are no labels (still a result at `@`)", () => {
    const res = run("@", 1, []);
    expect(res).not.toBeNull();
    expect(res!.options).toEqual([]);
  });

  it("reads labels lazily via the callback on each invocation", () => {
    let labels: string[] = ["a"];
    const source = labelCompletionSource(() => labels);
    let res = source(ctxAt("@", 1)) as CompletionResult | null;
    expect(res!.options.map((o) => o.label)).toEqual(["a"]);
    labels = ["a", "b"];
    res = source(ctxAt("@", 1)) as CompletionResult | null;
    expect(res!.options.map((o) => o.label)).toEqual(["a", "b"]);
  });
});
