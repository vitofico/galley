import { describe, it, expect } from "vitest";
import { makeStyleable } from "./make-styleable.js";
import { detectStyleability, CANONICAL_TOKENS } from "./style-manifest.js";

// An Einstein-LIKE fixture: a leading contiguous block of top-level styling
// directives (multi-line #set, #let color tokens, a multi-line #show heading
// rule with a brace body, a one-line #show heading), THEN body content (a
// heading + prose + #include). This mirrors the BEFORE shape of the real demo
// without depending on the demo files (owned by another concern).
const EINSTEIN_LIKE = `// cover sheet comment
#set page(
  paper: "a5",
  margin: (x: 1.85cm, y: 1.9cm),
  fill: rgb("#fffdf8"),
  numbering: "1",
)
#set text(font: "New Computer Modern", size: 10pt, fill: rgb("#211c17"))
#set par(justify: true, leading: 0.72em, first-line-indent: 1.2em)
#set heading(numbering: "I.1.")
#set math.equation(numbering: "(1)")

#let accent = rgb("#f0510e")
#let ink-soft = rgb("#6a6155")

// Every paper opens on its own leaf.
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  set text(size: 13.5pt, weight: 700)
  block(above: 1.4em, below: 0.9em, it)
}
#show heading.where(level: 2): set text(size: 11pt, weight: 600)

= Annus Mirabilis

Within a single twelvemonth, four papers.

#include "/photoelectric.typ"
`;

describe("makeStyleable", () => {
  it("lifts the leading styling block so the rewritten main detects as clean/shimmed", () => {
    const r = makeStyleable({ mainText: EINSTEIN_LIKE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const state = detectStyleability(r.mainText).state;
    expect(["clean", "shimmed"]).toContain(state);
  });

  it("rewrites main to import doc + apply it via #show, with no inline styling left", () => {
    const r = makeStyleable({ mainText: EINSTEIN_LIKE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mainText).toContain('#import "/style.typ": doc');
    expect(r.mainText).toContain("#show: doc.with(");
    // No top-level styling directives left inline.
    expect(r.mainText).not.toMatch(/^#set /m);
    expect(r.mainText).not.toMatch(/^#show heading/m);
    // Body content survives.
    expect(r.mainText).toContain("= Annus Mirabilis");
    expect(r.mainText).toContain('#include "/photoelectric.typ"');
  });

  it("builds a /style.typ doc() that carries the lifted directives + all four tokens", () => {
    const r = makeStyleable({ mainText: EINSTEIN_LIKE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // doc() signature with body before ..extra sink.
    expect(r.styleText).toMatch(/#let doc\([\s\S]*body,\s*\n\s*\.\.extra,?\s*\n\)/);
    // The lifted directives moved into the style.
    expect(r.styleText).toContain("set page(");
    expect(r.styleText).toContain("show heading.where(level: 1)");
    expect(r.styleText).toMatch(/^\s*body\s*$/m); // body emitted at the tail
    // All four canonical tokens defined.
    for (const tok of CANONICAL_TOKENS) {
      expect(r.styleText).toMatch(new RegExp(`#let ${tok}\\b`));
    }
  });

  it("reuses an existing accent #let color rather than overriding it", () => {
    const r = makeStyleable({ mainText: EINSTEIN_LIKE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The doc defined accent = rgb("#f0510e"); the style keeps that value.
    expect(r.styleText).toContain('#let accent = rgb("#f0510e")');
    expect(r.styleText).toContain('#let ink-soft = rgb("#6a6155")');
  });

  it("returns ok:false 'already styleable' for an already-conforming doc", () => {
    const CANON = `#import "/style.typ": doc, accent, ink, ink-soft, rule\n#show: doc.with(title: "T")\n= H`;
    const r = makeStyleable({ mainText: CANON });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already styleable/i);
  });

  it("returns ok:false for a shimmed (already-importing) doc too", () => {
    const ARTICLE = `#import "/style.typ": article, accent\n#show: article.with(title: "T")\n= H`;
    const r = makeStyleable({ mainText: ARTICLE });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false for a freeform doc with no leading styling", () => {
    const FREEFORM = `= Hello\n\nJust prose, no styling directives at all.\n`;
    const r = makeStyleable({ mainText: FREEFORM });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no .*styling|nothing to lift/i);
  });

  it("handles a minimal single-directive leading block", () => {
    const MIN = `#set page(margin: 2cm)\n\n= Title\n\nBody text.\n`;
    const r = makeStyleable({ mainText: MIN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(["clean", "shimmed"]).toContain(detectStyleability(r.mainText).state);
    expect(r.styleText).toContain("set page(margin: 2cm)");
  });
});
