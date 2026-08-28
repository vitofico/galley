import { describe, it, expect } from "vitest";
import { versionErrorNotice, type VersionOpKind } from "./version-error-notice.js";

describe("versionErrorNotice (L8)", () => {
  const kinds: VersionOpKind[] = ["save", "restore", "compare"];

  it("maps each op to plain-language copy with a recovery hint — never a raw error", () => {
    for (const kind of kinds) {
      const msg = versionErrorNotice(kind);
      // Reassures the work is unchanged + tells the user what to do next.
      expect(msg).toMatch(/unchanged/i);
      expect(msg).toMatch(/try /i);
      // Never leaks an implementation string (the raw err stays in the console).
      expect(msg).not.toMatch(/error|String\(|undefined|\[object/i);
    }
  });

  it("uses op-appropriate wording", () => {
    expect(versionErrorNotice("save")).toMatch(/save/i);
    expect(versionErrorNotice("restore")).toMatch(/restore/i);
    expect(versionErrorNotice("compare")).toMatch(/compare/i);
  });
});
