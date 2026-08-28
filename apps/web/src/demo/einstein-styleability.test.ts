import { describe, it, expect } from "vitest";
import { detectStyleability } from "../style-manifest.js";
import mainLive from "./live/main.typ?raw";

/**
 * Regression guard for the styleable Einstein demo (Phase 1.5): the live
 * `/main.typ` MUST stay a conforming, `clean` document so the Style Library can
 * swap its `/style.typ` in place. It imports only the canonical entry `doc`
 * (and, were the body to use them, palette tokens) — no semantic helper — and
 * `#show: doc.with(…)` drives the layout, so the classifier sees `clean`, not
 * `incompatible`/`non-conforming`. If the demo ever slips back to inlining its
 * styling (no `/style.typ` import) or pulls a custom command, this fails loudly.
 */
const ALLOWED_SYMBOLS = new Set(["doc", "accent", "ink", "ink-soft", "rule"]);

describe("Einstein live demo is styleable (#20 / styles Phase 1.5)", () => {
  it("classifies the live main.typ as clean (conforming, no shim needed)", () => {
    const s = detectStyleability(mainLive);
    expect(s.state).toBe("clean");
    expect(s.entrySymbol).toBe("doc");
    // Only the entry + (optionally) palette tokens are imported — no custom
    // helper symbol leaks in that a generic style couldn't provide.
    expect(s.importedSymbols.every((sym) => ALLOWED_SYMBOLS.has(sym))).toBe(true);
  });
});
