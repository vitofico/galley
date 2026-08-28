import { describe, it, expect } from "vitest";
import { applyEdits } from "@galley/agent";
import { appendSnippet, wholeSourceBlock } from "./authoring-insert.js";

describe("appendSnippet (#8/#15 insert)", () => {
  it("separates the new block from the body with one blank line", () => {
    expect(appendSnippet("= Doc\n\nBody.", "#figure(rect())")).toBe(
      "= Doc\n\nBody.\n\n#figure(rect())\n",
    );
  });

  it("trims the snippet's trailing whitespace and the source's trailing space", () => {
    expect(appendSnippet("A\n\n\n", "B\n\n")).toBe("A\n\nB\n");
  });

  it("yields just the snippet for an empty/blank source", () => {
    expect(appendSnippet("", "X")).toBe("X\n");
    expect(appendSnippet("   \n\n", "X")).toBe("X\n");
  });

  it("leaves the source unchanged for an empty snippet", () => {
    expect(appendSnippet("= Doc", "")).toBe("= Doc");
    expect(appendSnippet("= Doc", "   \n")).toBe("= Doc");
  });
});

describe("wholeSourceBlock (conflict-aware insert)", () => {
  it("applies cleanly via applyEdits when the live source is unchanged", () => {
    const base = "= Doc\n\nBody.";
    const next = appendSnippet(base, "#rect()");
    const res = applyEdits(base, wholeSourceBlock(base, next));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe(next);
  });

  it("conflicts (no clobber) when the live source moved out from under it", () => {
    const base = "= Doc\n\nBody.";
    const next = appendSnippet(base, "#rect()");
    // The user typed during the panel → current no longer equals base.
    const current = "= Doc (edited)\n\nBody.";
    const res = applyEdits(current, wholeSourceBlock(base, next));
    expect(res.ok).toBe(false); // search (the old whole source) no longer matches
  });
});
