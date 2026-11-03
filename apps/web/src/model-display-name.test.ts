import { describe, expect, it } from "vitest";
import { modelDisplayName } from "./model-display-name.js";

describe("modelDisplayName", () => {
  it("names Claude models without rewriting custom or dated model IDs", () => {
    expect(modelDisplayName("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(modelDisplayName("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelDisplayName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    for (const id of ["private-model", "gpt-4o", "claude-haiku-4-5-20251001"]) {
      expect(modelDisplayName(id)).toBe(id);
    }
  });
});
