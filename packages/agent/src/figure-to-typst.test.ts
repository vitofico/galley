import { describe, it, expect } from "vitest";
import type { ModelStep } from "./model.js";
import type { LanguageModelClient } from "./model.js";
import { messageText } from "./model.js";
import { FAKE_CONFIG, FakeCompiler, FakeModel, errorAt } from "./testing/fakes.js";
import { figureToTypst, cetzScaffold } from "./figure-to-typst.js";

/**
 * A model that replays a fixed list of assistant texts (the figure path reads
 * `step.text`, not tool calls). Records every turn input it saw so we can assert
 * that diagnostics were fed back on retries. Reuses the shared FakeModel via the
 * `text`-only step shape.
 */
function textModel(texts: string[]): FakeModel {
  const steps: ModelStep[] = texts.map((text) => ({ text, toolCalls: [] }));
  return new FakeModel(steps, FAKE_CONFIG);
}

/** A minimal CeTZ snippet that the FakeCompiler treats as clean. */
const CLEAN = `#import "@preview/cetz:0.2.2"\n#cetz.canvas({\n  import cetz.draw: *\n  circle((0, 0))\n})`;
/** A snippet the FakeCompiler will mark broken (contains BROKEN). */
const BROKEN = `#cetz.canvas({ BROKEN })`;

/** Marks any source containing "BROKEN" as a single error. */
const brokenDiagnose = (src: string) =>
  src.includes("BROKEN") ? [errorAt("unexpected token BROKEN", 1, 1)] : [];

describe("cetzScaffold", () => {
  it("returns a non-empty CeTZ-shaped snippet mentioning the description", () => {
    const out = cetzScaffold("a flowchart of the login process");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("cetz");
    expect(out).toContain("canvas");
    // The description is echoed (as a comment) so the model has a deterministic seed.
    expect(out).toContain("login process");
  });
});

describe("figureToTypst — clean on first attempt", () => {
  it("returns ok:true, attempts:1 when the model emits a clean snippet immediately", async () => {
    const model = textModel([CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await figureToTypst(
      { description: "a circle" },
      { model, compiler },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.typst).toContain("cetz.canvas");
    expect(compiler.callCount).toBe(1);
  });
});

describe("figureToTypst — self-correcting retry", () => {
  it("converges on attempt 2 and feeds the diagnostic back into the retry prompt", async () => {
    const model = textModel([BROKEN, CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await figureToTypst(
      { description: "a circle", kind: "diagram" },
      { model, compiler, maxAttempts: 3 },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(result.typst).toContain("cetz.canvas");

    // The retry (2nd turn) must include the diagnostic feedback from attempt 1.
    expect(model.seen).toHaveLength(2);
    const retryMessages = model.seen[1]!.messages;
    const fedBack = retryMessages.some((m) => messageText(m.content).includes("unexpected token BROKEN"));
    expect(fedBack).toBe(true);
    // The retry also carries the previous (broken) snippet for context.
    const carriedSnippet = retryMessages.some((m) => messageText(m.content).includes("BROKEN"));
    expect(carriedSnippet).toBe(true);
  });
});

describe("figureToTypst — exhausts attempts without converging", () => {
  it("returns ok:false after maxAttempts with the final diagnostics surfaced", async () => {
    const model = textModel([BROKEN, BROKEN, BROKEN, BROKEN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await figureToTypst(
      { description: "a circle" },
      { model, compiler, maxAttempts: 3 },
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(compiler.callCount).toBe(3);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.message).toContain("BROKEN");
    // The best (and only) snippet is still returned for inspection.
    expect(result.typst).toContain("BROKEN");
  });
});

describe("figureToTypst — empty model output falls back to the deterministic scaffold", () => {
  it("uses cetzScaffold when the model returns no usable snippet, and still compiles", async () => {
    const model = textModel([""]);
    const compiler = new FakeCompiler(); // everything clean
    const result = await figureToTypst(
      { description: "a labelled box" },
      { model, compiler },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.typst).toContain("cetz");
    expect(result.typst).toContain("labelled box");
  });
});

describe("figureToTypst — first prompt instructs CeTZ-only output", () => {
  it("sends a focused system prompt and the description on the first turn", async () => {
    const model = textModel([CLEAN]);
    const compiler = new FakeCompiler();
    await figureToTypst(
      { description: "a sequence diagram", kind: "diagram" },
      { model, compiler },
    );
    const first = model.seen[0]!;
    expect(first.system.toLowerCase()).toContain("cetz");
    const userMsg = first.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("a sequence diagram");
  });
});
