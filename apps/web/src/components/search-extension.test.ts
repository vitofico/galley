import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { searchPanelExtension } from "./search-extension.js";

/**
 * Smoke tests for the search/find-replace factory. The factory is intentionally
 * thin: it bundles `@codemirror/search` pieces + a token-based theme. Heavy panel
 * behaviour (open on Mod-f, replace, etc.) is e2e (coordinator-owned), so here we
 * only assert the factory constructs a usable, non-empty Extension that an
 * EditorState will accept.
 */
describe("searchPanelExtension", () => {
  it("returns a non-empty extension array", () => {
    const ext = searchPanelExtension();
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBeGreaterThan(0);
  });

  it("can be installed into an EditorState without throwing", () => {
    expect(() =>
      EditorState.create({
        doc: "hello world",
        extensions: [searchPanelExtension()],
      }),
    ).not.toThrow();
  });

  it("does not change the document (inert at rest)", () => {
    const state = EditorState.create({
      doc: "alpha beta",
      extensions: [searchPanelExtension()],
    });
    expect(state.doc.toString()).toBe("alpha beta");
  });
});
