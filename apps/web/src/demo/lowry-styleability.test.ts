import { describe, it, expect } from "vitest";
import { detectStyleability } from "../style-manifest.js";
import mainLive from "./lowry-1951/main.typ?raw";

/**
 * Regression guard for the styleable Lowry demo: the `/main.typ` MUST stay a
 * conforming, `clean` document so the Style Library can swap its bespoke journal
 * `/style.typ` in place (academic / modern / minimal). It imports only the
 * canonical entry `doc` (the journal-specific `journal`/`articletype`/
 * `affiliation`/`received` ride in as `#show: doc.with(...)` NAMED ARGUMENTS,
 * not style imports), so the classifier sees `clean`, not `incompatible`/
 * `non-conforming`. If the demo ever inlines its styling or pulls a custom
 * helper symbol from the style, this fails loudly.
 */
const ALLOWED_SYMBOLS = new Set(["doc", "accent", "ink", "ink-soft", "rule"]);

describe("Lowry demo is styleable (journal-style seed)", () => {
  it("classifies the main.typ as clean (conforming, no shim needed)", () => {
    const s = detectStyleability(mainLive);
    expect(s.state).toBe("clean");
    expect(s.entrySymbol).toBe("doc");
    expect(s.requiredCapabilities).toEqual([]);
    // Only the entry + (optionally) palette tokens are imported — no custom
    // helper symbol a generic style couldn't provide.
    expect(s.importedSymbols.every((sym) => ALLOWED_SYMBOLS.has(sym))).toBe(true);
  });
});
