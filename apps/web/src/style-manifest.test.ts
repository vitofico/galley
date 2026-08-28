import { describe, it, expect } from "vitest";
import { detectStyleability, generateShim, negotiate } from "./style-manifest.js";

const ARTICLE = `#import "/style.typ": article, accent, ink-soft, line-strong\n#show: article.with(title: "T")\n= H`;
const CANON = `#import "/style.typ": doc, accent, ink, ink-soft, rule\n#show: doc.with(title: "T")\n= H`;
const PSET = `#import "/style.typ": pset, problem, solution\n#show: pset.with()\n= H`;
const FREEFORM = `#set page(margin: 2cm)\n= Hello`;
const WILDCARD = `#import "/style.typ": *\n#show: doc.with(title: "T")\n= H`;

describe("detectStyleability", () => {
  it("flags a canonical doc as clean with no required capabilities", () => {
    const r = detectStyleability(CANON);
    expect(r.state).toBe("clean");
    expect(r.entrySymbol).toBe("doc");
    expect(r.importedSymbols).toEqual(["doc", "accent", "ink", "ink-soft", "rule"]);
    expect(r.requiredCapabilities).toEqual([]);
  });

  it("flags an article (aliased entry + token) as shimmed", () => {
    const r = detectStyleability(ARTICLE);
    expect(r.state).toBe("shimmed");
    expect(r.entrySymbol).toBe("article");
    expect(r.tokenAliases).toEqual({ "line-strong": "rule" });
    expect(r.requiredCapabilities).toEqual([]);
  });

  it("records semantic helpers as required capabilities (no longer hard-incompatible)", () => {
    const r = detectStyleability(PSET);
    // pset entry is aliased onto doc, so it still needs a shim — but it is NOT
    // hard-blocked: the helpers it pulls are recorded for swap-time negotiation.
    expect(r.state).toBe("shimmed");
    expect(r.requiredCapabilities).toEqual(["problem", "solution"]);
  });

  it("sorts and dedupes required capabilities", () => {
    const doc = `#import "/style.typ": doc, theorem, fig, theorem\n#show: doc.with()\n= H`;
    expect(detectStyleability(doc).requiredCapabilities).toEqual(["fig", "theorem"]);
  });

  it("flags a doc with no /style.typ import as non-conforming", () => {
    expect(detectStyleability(FREEFORM).state).toBe("non-conforming");
  });

  it("fails CLOSED on a wildcard import (can't enumerate what it needs)", () => {
    const r = detectStyleability(WILDCARD);
    expect(r.state).toBe("incompatible");
    expect(r.reason).toMatch(/\*|everything|wildcard/i);
  });

  it("aggregates required capabilities PROJECT-WIDE across every file importing /style.typ", () => {
    // main imports only the canonical ABI; a secondary chapter file pulls `fig`
    // and `caption` from the same style. A main-only scan would falsely approve a
    // swap to a style lacking those helpers.
    const chapter = `#import "/style.typ": fig, caption\n= Chapter\n#fig(image("x.png"))`;
    const intro = `#import "/style.typ": caption\n#caption[hi]`;
    const r = detectStyleability(CANON, [chapter, intro]);
    expect(r.state).toBe("clean");
    expect(r.requiredCapabilities).toEqual(["caption", "fig"]);
  });
});

describe("negotiate", () => {
  it("allows a swap when the style provides every required capability", () => {
    expect(negotiate(["fig", "theorem"], ["fig", "theorem", "affil"])).toEqual({ ok: true });
  });

  it("allows a swap when nothing is required", () => {
    expect(negotiate([], [])).toEqual({ ok: true });
  });

  it("refuses a swap and names the missing capabilities (sorted)", () => {
    expect(negotiate(["theorem", "fig", "affil"], ["fig"])).toEqual({
      ok: false,
      missing: ["affil", "theorem"],
    });
  });
});

describe("generateShim", () => {
  it("re-exports the entry name and aliases tokens for a shimmed doc", () => {
    const shim = generateShim(detectStyleability(ARTICLE));
    expect(shim).toContain("#let article = doc");
    expect(shim).toContain("#let line-strong = rule");
  });

  it("returns empty for a clean doc", () => {
    expect(generateShim(detectStyleability(CANON)).trim()).toBe("");
  });

  it("returns empty for a fail-closed (incompatible) doc", () => {
    expect(generateShim(detectStyleability(WILDCARD)).trim()).toBe("");
  });
});
