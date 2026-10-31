import { describe, expect, it } from "vitest";
import { layoutCandidates, replaceScratchMain } from "./layout-auditions.js";
import { resolveAccept } from "./accept.js";
describe("layout auditions", () => {
  it("preserves all original wording and size rules in scratch candidates", () => {
    const source =
      '#set text(size: 9pt)\nA value of 12 kg.\n#image("asset.png")';
    expect(layoutCandidates(source, 20, 5).map((c) => c.source)).toEqual(
      [15, 20, 25].map((m) => `#set page(margin: ${m}mm)\n${source}`),
    );
  });
  it("leaves siblings and binary assets intact and refuses a non-main target", () => {
    const input = {
      kind: "project" as const,
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: "old" },
        { path: "/other.typ", text: "sibling" },
      ],
      binaryFiles: [{ path: "/asset.png", bytes: new Uint8Array([1]) }],
    };
    const scratch = replaceScratchMain(input, "/main.typ", "new");
    expect(scratch).toEqual({
      ...input,
      files: [{ path: "/main.typ", text: "new" }, input.files[1]],
    });
    expect(input.files[0]?.text).toBe("old");
    expect(() => replaceScratchMain(input, "/other.typ", "new")).toThrow(
      /main/,
    );
  });
  it("uses conflict-aware full-file Accept, refusing concurrent edits", () =>
    expect(resolveAccept("typed", "old", "layout", []).applied).toBe(false));
  it("rejects invalid user constraints", () =>
    expect(() => layoutCandidates("a", NaN, 5)).toThrow());
});
