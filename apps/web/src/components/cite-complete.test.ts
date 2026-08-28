/**
 * Roadmap #6: cite-key completion source. Verifies it is a composable
 * CompletionSource that fires after `@`, offers matching INJECTED keys, and stays
 * quiet elsewhere. Keys are passed inline — this test (like the source) never
 * touches citation.ts or @galley/agent.
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { citeCompletionSource } from "./cite-complete.js";

const KEYS = ["smith2020", "smithers2019", "knuth1997"];

/**
 * Run the source against a doc where `|` marks the cursor. Returns the result (or
 * null). `explicit` simulates a Ctrl-Space invocation.
 */
function run(docWithCursor: string, explicit = false): CompletionResult | null {
  const pos = docWithCursor.indexOf("|");
  const doc = docWithCursor.replace("|", "");
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, pos, explicit);
  const source = citeCompletionSource(() => KEYS);
  return source(ctx) as CompletionResult | null;
}

describe("citeCompletionSource", () => {
  it("offers matching keys after an `@` prefix", () => {
    const res = run("see @smi|");
    expect(res).not.toBeNull();
    const labels = res!.options.map((o) => o.label);
    expect(labels).toContain("@smith2020");
    expect(labels).toContain("@smithers2019");
    expect(labels).not.toContain("@knuth1997");
  });

  it("matches from the `@` so completion replaces the whole token", () => {
    const res = run("see @smi|");
    // `@` is at index 4 in "see @smi"
    expect(res!.from).toBe(4);
  });

  it("applies the full `@key`", () => {
    const res = run("@smi|");
    const opt = res!.options.find((o) => o.label === "@smith2020");
    expect(opt).toBeDefined();
    expect(opt!.apply).toBe("@smith2020");
  });

  it("returns nothing when there is no `@` before the cursor", () => {
    expect(run("plain text|")).toBeNull();
    expect(run("smith2020|")).toBeNull();
  });

  it("does not pop on a bare `@` unless explicitly invoked", () => {
    expect(run("see @|")).toBeNull();
    const res = run("see @|", true);
    expect(res).not.toBeNull();
    expect(res!.options.map((o) => o.label).sort()).toEqual([
      "@knuth1997",
      "@smith2020",
      "@smithers2019",
    ]);
  });

  it("is case-insensitive on the typed prefix", () => {
    const res = run("@SMI|");
    expect(res).not.toBeNull();
    expect(res!.options.map((o) => o.label)).toContain("@smith2020");
  });

  it("returns null when no injected key matches", () => {
    expect(run("@zzz|")).toBeNull();
  });

  it("reflects the live key set from getKeys per call", () => {
    let keys = ["alpha2000"];
    const state = EditorState.create({ doc: "@al" });
    const source = citeCompletionSource(() => keys);
    const first = source(new CompletionContext(state, 3, false)) as CompletionResult | null;
    expect(first!.options.map((o) => o.label)).toEqual(["@alpha2000"]);
    keys = ["alphabet1999"];
    const second = source(new CompletionContext(state, 3, false)) as CompletionResult | null;
    expect(second!.options.map((o) => o.label)).toEqual(["@alphabet1999"]);
  });
});
