import { describe, it, expect } from "vitest";
import type { ContentPart, ModelStep } from "./model.js";
import { FAKE_CONFIG, FakeModel } from "./testing/fakes.js";
import { suggestAltText, normalizeAltText } from "./figure-alt-text.js";

function textModel(texts: string[]): FakeModel {
  const steps: ModelStep[] = texts.map((text) => ({ text, toolCalls: [] }));
  return new FakeModel(steps, FAKE_CONFIG);
}

describe("suggestAltText — multimodal ask", () => {
  it("returns the model's concise caption", async () => {
    const model = textModel(["A bar chart comparing quarterly revenue across four regions."]);
    const alt = await suggestAltText({
      image: { data: "data:image/png;base64,AAAA", mimeType: "image/png" },
      model,
    });
    expect(alt).toBe("A bar chart comparing quarterly revenue across four regions.");
  });

  it("sends a multimodal user message carrying an image part", async () => {
    const model = textModel(["A diagram."]);
    await suggestAltText({
      image: { data: "data:image/png;base64,CCCC", mimeType: "image/png" },
      context: "Figure 2 in the Methods section.",
      model,
    });

    expect(model.seen).toHaveLength(1);
    const turn = model.seen[0]!;
    expect(turn.tools).toEqual([]);
    const parts = turn.messages[0]!.content as ContentPart[];

    const imagePart = parts.find((p) => p.type === "image");
    expect(imagePart).toMatchObject({
      type: "image",
      image: "data:image/png;base64,CCCC",
      mimeType: "image/png",
    });

    const textPart = parts.find((p) => p.type === "text") as { text: string };
    expect(textPart.text).toContain("Methods section");
  });

  it("strips a leading label and wrapping quotes", () => {
    expect(normalizeAltText('Alt text: "A red square."')).toBe("A red square.");
    expect(normalizeAltText("Caption: A flowchart")).toBe("A flowchart");
  });

  it("returns empty string when the model says nothing usable", async () => {
    const model = textModel([""]);
    const alt = await suggestAltText({ image: { data: new Uint8Array([1, 2]) }, model });
    expect(alt).toBe("");
  });

  it("caps an over-long reply on a word boundary with an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const out = normalizeAltText(long);
    expect(out.length).toBeLessThanOrEqual(241);
    expect(out.endsWith("…")).toBe(true);
    // Cut on a word boundary: no partial trailing token before the ellipsis.
    expect(out.slice(0, -1).trimEnd().endsWith("word")).toBe(true);
  });
});
