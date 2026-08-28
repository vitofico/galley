import { describe, it, expect } from "vitest";
import type { ContentPart, ModelStep } from "./model.js";
import { messageText } from "./model.js";
import { FAKE_CONFIG, FakeCompiler, FakeModel, errorAt } from "./testing/fakes.js";
import { figureFromSketch } from "./figure-from-sketch.js";

function textModel(texts: string[]): FakeModel {
  const steps: ModelStep[] = texts.map((text) => ({ text, toolCalls: [] }));
  return new FakeModel(steps, FAKE_CONFIG);
}

const CLEAN = `#import "@preview/cetz:0.2.2"\n#cetz.canvas({\n  import cetz.draw: *\n  circle((0, 0))\n})`;
const BROKEN = `#cetz.canvas({ BROKEN })`;
const brokenDiagnose = (src: string) =>
  src.includes("BROKEN") ? [errorAt("unexpected token BROKEN", 1, 1)] : [];

const SKETCH = { data: "data:image/png;base64,AAAA", mimeType: "image/png" } as const;

describe("figureFromSketch — clean on first attempt", () => {
  it("returns ok:true with a compilable snippet and a multimodal first turn", async () => {
    const model = textModel([CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await figureFromSketch({
      sketch: SKETCH,
      description: "two boxes joined by an arrow",
      model,
      compiler,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.typst).toContain("cetz.canvas");
    expect(compiler.callCount).toBe(1);

    // First user turn is multimodal and carries the sketch image part.
    const firstTurn = model.seen[0]!;
    expect(firstTurn.tools).toEqual([]);
    const parts = firstTurn.messages[0]!.content as ContentPart[];
    expect(Array.isArray(parts)).toBe(true);
    const imagePart = parts.find((p) => p.type === "image");
    expect(imagePart).toMatchObject({
      type: "image",
      image: "data:image/png;base64,AAAA",
      mimeType: "image/png",
    });
    const textPart = parts.find((p) => p.type === "text") as { text: string };
    expect(textPart.text).toContain("two boxes joined by an arrow");
  });
});

describe("figureFromSketch — self-correcting retry", () => {
  it("converges on attempt 2 and feeds diagnostics back as a text turn", async () => {
    const model = textModel([BROKEN, CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await figureFromSketch({
      sketch: SKETCH,
      model,
      compiler,
      maxAttempts: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);

    // The retry (2nd turn) includes the diagnostic feedback from attempt 1.
    expect(model.seen).toHaveLength(2);
    const retryMessages = model.seen[1]!.messages;
    const fedBack = retryMessages.some((m) =>
      messageText(m.content).includes("unexpected token BROKEN"),
    );
    expect(fedBack).toBe(true);
  });
});

describe("figureFromSketch — empty model output falls back to the scaffold", () => {
  it("uses the deterministic scaffold when the model returns nothing", async () => {
    const model = textModel([""]);
    const compiler = new FakeCompiler(); // everything clean
    const result = await figureFromSketch({
      sketch: SKETCH,
      description: "a labelled box",
      model,
      compiler,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.typst).toContain("cetz");
    expect(result.typst).toContain("labelled box");
  });

  it("falls back even with no description (uses a generic seed)", async () => {
    const model = textModel([""]);
    const compiler = new FakeCompiler();
    const result = await figureFromSketch({ sketch: SKETCH, model, compiler });
    expect(result.ok).toBe(true);
    expect(result.typst).toContain("cetz.canvas");
  });
});

describe("figureFromSketch — exhausts attempts without converging", () => {
  it("returns ok:false after maxAttempts with the final diagnostics surfaced", async () => {
    const model = textModel([BROKEN, BROKEN, BROKEN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await figureFromSketch({
      sketch: SKETCH,
      model,
      compiler,
      maxAttempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.message).toContain("BROKEN");
  });
});
