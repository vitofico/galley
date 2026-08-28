/**
 * First-boot lint regression (#20.2): the seeded "Annus Mirabilis" workspace
 * must boot with ZERO broken-ref warnings. Mirrors ProjectApp's wiring exactly:
 * the cross-file ref lint runs over the live `.typ` files with cite keys taken
 * from the project's `.bib` text. Caught in the wild as a "5:15 unknown
 * reference @preview" false positive — main.typ's header COMMENT mentions
 * `@preview`, and the lexical scan used to read comments as markup.
 */
import { describe, it, expect } from "vitest";
import { crossFileRefDiagnostics, citeKeysFromBibliography } from "@galley/agent";
import { DEMO_FILES } from "./einstein-1905.js";

describe("Annus Mirabilis demo (first boot)", () => {
  it("produces no broken-ref lint warnings", () => {
    const typFiles = DEMO_FILES.filter((f) => f.path.endsWith(".typ"));
    const bibText = DEMO_FILES.filter((f) => f.path.toLowerCase().endsWith(".bib"))
      .map((f) => f.text)
      .join("\n\n");
    const diags = crossFileRefDiagnostics(typFiles, citeKeysFromBibliography(bibText));
    expect(diags).toEqual([]);
  });
});
