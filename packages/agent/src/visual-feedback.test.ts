import { describe, it, expect } from "vitest";
import type { ContentPart, ModelStep } from "./model.js";
import { FAKE_CONFIG, FakeModel } from "./testing/fakes.js";
import { judgeLayout, parseLayoutFeedback } from "./visual-feedback.js";

/** A model that replays one scripted assistant text (the feedback reply). */
function textModel(texts: string[]): FakeModel {
  const steps: ModelStep[] = texts.map((text) => ({ text, toolCalls: [] }));
  return new FakeModel(steps, FAKE_CONFIG);
}

const SCRIPTED = [
  "SUMMARY: The page has an overfull line and a stranded figure.",
  "OBSERVATIONS:",
  "- Line 3 is overfull by 4pt and runs into the margin.",
  "- The figure floats to the next page, leaving a large gap.",
  "SUGGESTED EDITS: Rewrap the paragraph on line 3 and place the figure with [placement: top].",
].join("\n");

describe("judgeLayout — multimodal request + structured parse", () => {
  it("parses the assistant reply into LayoutFeedback", async () => {
    const model = textModel([SCRIPTED]);
    const result = await judgeLayout({
      source: "#figure(rect())",
      image: { data: "data:image/png;base64,AAAA", mimeType: "image/png" },
      model,
    });

    expect(result.summary).toBe("The page has an overfull line and a stranded figure.");
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toContain("overfull");
    expect(result.observations[1]).toContain("figure");
    expect(result.suggestedEdits).toContain("placement: top");
  });

  it("sends a multimodal user message carrying an image part + the source", async () => {
    const model = textModel([SCRIPTED]);
    await judgeLayout({
      source: "#let x = 1",
      image: { data: "data:image/png;base64,BBBB", mimeType: "image/png" },
      model,
    });

    expect(model.seen).toHaveLength(1);
    const turn = model.seen[0]!;
    expect(turn.tools).toEqual([]);
    const userMsg = turn.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);

    const parts = userMsg!.content as ContentPart[];
    const imagePart = parts.find((p) => p.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart).toMatchObject({
      type: "image",
      image: "data:image/png;base64,BBBB",
      mimeType: "image/png",
    });

    const textPart = parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect((textPart as { text: string }).text).toContain("#let x = 1");
  });

  it("carries raw bytes through unchanged in the image part", async () => {
    const model = textModel([SCRIPTED]);
    const bytes = new Uint8Array([1, 2, 3]);
    await judgeLayout({ source: "x", image: { data: bytes }, model });

    const parts = model.seen[0]!.messages[0]!.content as ContentPart[];
    const imagePart = parts.find((p) => p.type === "image")!;
    expect((imagePart as { image: Uint8Array }).image).toBe(bytes);
  });
});

describe("parseLayoutFeedback — degradation", () => {
  it("treats 'none' suggested edits as absent", () => {
    const fb = parseLayoutFeedback(
      ["SUMMARY: Looks good.", "OBSERVATIONS:", "- Nothing major.", "SUGGESTED EDITS: none"].join(
        "\n",
      ),
    );
    expect(fb.summary).toBe("Looks good.");
    expect(fb.observations).toEqual(["Nothing major."]);
    expect(fb.suggestedEdits).toBeUndefined();
  });

  it("falls back to first-line summary when the template is ignored", () => {
    const fb = parseLayoutFeedback("The margins feel cramped.\nConsider widening them.");
    expect(fb.summary).toBe("The margins feel cramped.");
    expect(fb.observations).toEqual(["Consider widening them."]);
  });

  it("handles empty model output without throwing", () => {
    const fb = parseLayoutFeedback("");
    expect(fb.summary).toContain("No feedback");
    expect(fb.observations).toEqual([]);
  });
});
