/**
 * Roadmap #6: citation ergonomics core. These tests pin the CRUX — stable,
 * deterministic cite-keys + dedup — plus input classification, BibTeX parsing,
 * Hayagriva rendering, and the fail-closed, injected-fetch network path.
 */
import { describe, it, expect } from "vitest";
import {
  detectInputKind,
  parseBibtex,
  foldLatexAccents,
  toHayagriva,
  makeCiteKey,
  dedupeEntries,
  fetchCitation,
  crossrefToEntry,
  CitationFetchError,
  type CitationEntry,
  type CrossrefEnvelope,
} from "./citation.js";

describe("detectInputKind", () => {
  it("detects bare and prefixed DOIs", () => {
    expect(detectInputKind("10.1145/3290605.3300233")).toBe("doi");
    expect(detectInputKind("doi:10.1038/nphys1170")).toBe("doi");
    expect(detectInputKind("https://doi.org/10.1038/nphys1170")).toBe("doi");
    expect(detectInputKind("https://dx.doi.org/10.1038/nphys1170")).toBe("doi");
  });

  it("detects plain http(s) URLs", () => {
    expect(detectInputKind("https://example.com/paper")).toBe("url");
    expect(detectInputKind("http://example.org/x")).toBe("url");
  });

  it("detects BibTeX entries", () => {
    expect(detectInputKind("@article{foo2020, title={X}}")).toBe("bibtex");
    expect(detectInputKind("  @book{ bar , year = {1999} }")).toBe("bibtex");
  });

  it("returns unknown for everything else", () => {
    expect(detectInputKind("")).toBe("unknown");
    expect(detectInputKind("just some words")).toBe("unknown");
    expect(detectInputKind("10.notadoi")).toBe("unknown");
  });
});

describe("parseBibtex", () => {
  it("parses a single entry with common fields", () => {
    const src = `@article{smith2020,
      author = {Smith, Jane and Doe, John},
      title = {On the Theory of Everything},
      journal = {Journal of Things},
      year = {2020},
      volume = {12},
      number = {3},
      pages = {45--67},
      doi = {10.1000/xyz123}
    }`;
    const [e] = parseBibtex(src);
    expect(e).toBeDefined();
    expect(e!.key).toBe("smith2020");
    expect(e!.type).toBe("article");
    expect(e!.title).toBe("On the Theory of Everything");
    expect(e!.author).toEqual(["Smith, Jane", "Doe, John"]);
    expect(e!.journal).toBe("Journal of Things");
    expect(e!.year).toBe("2020");
    expect(e!.volume).toBe("12");
    expect(e!.number).toBe("3");
    expect(e!.pages).toBe("45--67");
    expect(e!.doi).toBe("10.1000/xyz123");
  });

  it("parses editor (split on ' and ') and abstract scalar (G7)", () => {
    const src = `@incollection{ed2010,
      author = {Author, A.},
      editor = {Edmund, Ed and Frey, Fran},
      title = {A Chapter},
      abstract = {A short summary of the work.},
      year = {2010}
    }`;
    const [e] = parseBibtex(src);
    expect(e!.editor).toEqual(["Edmund, Ed", "Frey, Fran"]);
    expect(e!.abstract).toBe("A short summary of the work.");
    // author still independent of editor
    expect(e!.author).toEqual(["Author, A."]);
  });

  it("parses multiple entries and quoted values", () => {
    const src = `
      @book{knuth1997, author="Knuth, Donald", title="The Art of Computer Programming", year="1997"}
      @inproceedings{lamport1978, author = {Lamport, Leslie}, title = {Time, Clocks}, year = {1978}}
    `;
    const entries = parseBibtex(src);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.key).toBe("knuth1997");
    expect(entries[0]!.author).toEqual(["Knuth, Donald"]);
    expect(entries[1]!.key).toBe("lamport1978");
    expect(entries[1]!.type).toBe("inproceedings");
    expect(entries[1]!.title).toBe("Time, Clocks"); // comma inside braces preserved
  });

  it("tolerates missing fields and skips @comment/@string", () => {
    const src = `
      @comment{ignore me}
      @string{foo = "bar"}
      @misc{nothing2001}
    `;
    const entries = parseBibtex(src);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("nothing2001");
    expect(entries[0]!.title).toBeUndefined();
    expect(entries[0]!.author).toBeUndefined();
  });

  it("extracts a 4-digit year from a noisy year field", () => {
    const [e] = parseBibtex(`@article{x, year={2019-03}}`);
    expect(e!.year).toBe("2019");
  });

  it("resyncs past a malformed mid-library entry instead of swallowing the rest (G4)", () => {
    // #2 is unbalanced ({Unclosed never closes). The parser must skip it and
    // resume at #3 rather than stopping dead, so #1 and #3 both survive.
    const src = [
      "@article{first2000, title={Alpha}, year={2000}}",
      "@article{broken, title={Unclosed",
      "@article{last2001, title={Omega}, year={2001}}",
    ].join("\n");
    const parsed = parseBibtex(src);
    expect(parsed.map((e) => e.key)).toEqual(["first2000", "last2001"]);
    expect(parsed.some((e) => e.title === "Omega")).toBe(true);
  });
});

describe("parseBibtex — @string macro expansion (G5-@string)", () => {
  it("expands a bareword field value against an @string definition", () => {
    const src = `
      @string{jmlr = {Journal of Machine Learning Research}}
      @article{x, title = {T}, journal = jmlr, year = {2020}}
    `;
    const [e] = parseBibtex(src);
    expect(e!.journal).toBe("Journal of Machine Learning Research");
  });

  it("treats macro names case-insensitively (definition and reference)", () => {
    const src = `
      @string{ACM = {ACM Press}}
      @book{x, title = {T}, publisher = acm, year = {1990}}
    `;
    const [e] = parseBibtex(src);
    expect(e!.publisher).toBe("ACM Press");
  });

  it("expands a `#`-concatenation of quoted strings and macros", () => {
    const src = `
      @string{conf = {WWW}}
      @inproceedings{x, journal = "Proc. " # conf # " 2020", title = {T}, year = {2020}}
    `;
    const [e] = parseBibtex(src);
    expect(e!.journal).toBe("Proc. WWW 2020");
  });

  it("leaves an unknown bareword as its own literal text (fail-open)", () => {
    const src = `@article{x, title = {T}, journal = neverdefined, year = {2020}}`;
    const [e] = parseBibtex(src);
    expect(e!.journal).toBe("neverdefined");
  });

  it("resolves macro-of-macro only against EARLIER defs (definition-time, no chains)", () => {
    // `outer = inner` is resolved AT DEFINITION against the macros collected SO FAR,
    // so since `inner` was defined earlier, `outer` stores inner's value "DEEP".
    // This is still strictly one-level/forward-only: a macro can only ever see
    // EARLIER definitions, so there are no forward refs and no cycles by construction.
    const src = `
      @string{inner = {DEEP}}
      @string{outer = inner}
      @article{x, title = {T}, journal = outer, year = {2020}}
    `;
    const [e] = parseBibtex(src);
    expect(e!.journal).toBe("DEEP");
  });

  it("a FORWARD macro reference is NOT resolved (only earlier defs are visible)", () => {
    // `early = late` is collected BEFORE `late` exists, so it fails open to the
    // literal "late" — proving lookups are backward-only (no second pass, no chase).
    const src = `
      @string{early = late}
      @string{late = {TOOLATE}}
      @article{x, title = {T}, journal = early, year = {2020}}
    `;
    const [e] = parseBibtex(src);
    expect(e!.journal).toBe("late");
  });

  it("does not hang or throw on a mutually-referential macro cycle (a=b, b=a)", () => {
    const src = `
      @string{a = b}
      @string{b = a}
      @article{x, title = {T}, journal = a, publisher = b, year = {2020}}
    `;
    const [e] = parseBibtex(src);
    // a was defined before b, so `a = b` stores the literal "b" (b unknown yet);
    // `b = a` stores a's value "b" (a is known = "b"). journal=a → "b"; publisher=b → "b".
    expect(e!.journal).toBe("b");
    expect(e!.publisher).toBe("b");
  });

  it("does not affect entries with no macros (braced/quoted unchanged)", () => {
    const src = `@article{x, title = {Plain Title}, journal = {Some Journal}, year = {2020}}`;
    const [e] = parseBibtex(src);
    expect(e!.title).toBe("Plain Title");
    expect(e!.journal).toBe("Some Journal");
  });

  it("expands a macro reference inside an author value path too", () => {
    const src = `
      @string{anon = {Anonymous, A.}}
      @misc{x, author = anon, title = {T}, year = {2020}}
    `;
    const [e] = parseBibtex(src);
    expect(e!.author).toEqual(["Anonymous, A."]);
  });

  it("stays linear with thousands of defs + refs and a cycle (<1s, no hang)", () => {
    const N = 5000;
    const defs: string[] = [`@string{a = b}`, `@string{b = a}`]; // cycle
    for (let n = 0; n < N; n++) defs.push(`@string{m${n} = {V${n}}}`);
    const entries: string[] = [];
    for (let n = 0; n < N; n++) {
      entries.push(`@article{e${n}, title = {T${n}}, journal = m${n}, year = {2000}}`);
    }
    const src = defs.join("\n") + "\n" + entries.join("\n");
    const t0 = Date.now();
    const parsed = parseBibtex(src);
    const dt = Date.now() - t0;
    expect(parsed).toHaveLength(N);
    expect(parsed[0]!.journal).toBe("V0");
    expect(parsed[N - 1]!.journal).toBe(`V${N - 1}`);
    expect(dt).toBeLessThan(1000);
  });
});

describe("parseBibtex — one-level crossref inheritance (G5-crossref)", () => {
  it("fills ONLY missing fields from the crossref parent", () => {
    const src = `
      @incollection{child, crossref = {parent}, author = {Child, C.}, title = {Child Title}, year = {1986}}
      @book{parent, title = {Parent Title}, publisher = {Parent Press}, year = {1990}}
    `;
    const entries = parseBibtex(src);
    const child = entries.find((e) => e.key === "child")!;
    // present-on-child fields are NOT overwritten:
    expect(child.title).toBe("Child Title");
    expect(child.year).toBe("1986");
    // missing field is inherited from the parent:
    expect(child.publisher).toBe("Parent Press");
  });

  it("inherits a parent field that itself came from an @string macro", () => {
    const src = `
      @string{acm = {ACM Press}}
      @incollection{child, crossref = {parent}, title = {C}, year = {1986}}
      @book{parent, title = {P}, publisher = acm, year = {1990}}
    `;
    const child = parseBibtex(src).find((e) => e.key === "child")!;
    expect(child.publisher).toBe("ACM Press");
  });

  it("matches the parent key case-insensitively", () => {
    const src = `
      @incollection{child, crossref = {PARENT}, title = {C}, year = {1986}}
      @book{parent, title = {P}, publisher = {PP}, year = {1990}}
    `;
    const child = parseBibtex(src).find((e) => e.key === "child")!;
    expect(child.publisher).toBe("PP");
  });

  it("is a no-op when the crossref parent is missing", () => {
    const src = `@incollection{child, crossref = {ghost}, title = {C}, year = {1986}}`;
    const child = parseBibtex(src).find((e) => e.key === "child")!;
    expect(child.publisher).toBeUndefined();
    expect(child.title).toBe("C");
  });

  it("does NOT chain: a grandparent field is not inherited two levels", () => {
    // child → parent → grandparent. child inherits only from parent's OWN fields;
    // a field that exists solely on the grandparent does not reach the child.
    const src = `
      @incollection{child, crossref = {parent}, title = {C}, year = {1986}}
      @incollection{parent, crossref = {grand}, title = {P}, year = {1988}}
      @book{grand, title = {G}, publisher = {GrandPress}, year = {1990}}
    `;
    const entries = parseBibtex(src);
    const child = entries.find((e) => e.key === "child")!;
    const parent = entries.find((e) => e.key === "parent")!;
    // parent inherited publisher from grand (one level for parent):
    expect(parent.publisher).toBe("GrandPress");
    // but child did NOT get it (we read parent's state BEFORE its own crossref
    // fill, OR equivalently never follow chains) — one level, no transitive reach.
    expect(child.publisher).toBeUndefined();
  });

  it("ignores a self-referential crossref without looping", () => {
    const src = `@book{loop, crossref = {loop}, title = {Self}, year = {2000}}`;
    const e = parseBibtex(src).find((x) => x.key === "loop")!;
    expect(e.title).toBe("Self");
  });
});

describe("foldLatexAccents (G5-accents)", () => {
  it("folds braced single-char accents ({\\\"o} → ö)", () => {
    expect(foldLatexAccents('{\\"o}')).toBe("{ö}");
    expect(foldLatexAccents("{\\'e}")).toBe("{é}");
    expect(foldLatexAccents("{\\`a}")).toBe("{à}");
    expect(foldLatexAccents("{\\^o}")).toBe("{ô}");
    expect(foldLatexAccents("{\\~n}")).toBe("{ñ}");
    expect(foldLatexAccents("{\\=o}")).toBe("{ō}");
  });

  it("folds the brace-after-command form (\\\"{o} → ö)", () => {
    expect(foldLatexAccents('\\"{o}')).toBe("ö");
    expect(foldLatexAccents("\\'{e}")).toBe("é");
  });

  it("folds the unbraced form (\\\"o → ö)", () => {
    expect(foldLatexAccents('M\\"uller')).toBe("Müller");
    expect(foldLatexAccents("Garc\\'ia")).toBe("García");
  });

  it("folds word-accent commands (\\v{s} → š, \\c{c} → ç, \\r{a} → å)", () => {
    expect(foldLatexAccents("\\v{s}")).toBe("š");
    expect(foldLatexAccents("\\c{c}")).toBe("ç");
    expect(foldLatexAccents("\\r{a}")).toBe("å");
    expect(foldLatexAccents("\\H{o}")).toBe("ő");
    expect(foldLatexAccents("\\k{a}")).toBe("ą");
    expect(foldLatexAccents("\\u{g}")).toBe("ğ");
  });

  it("folds special standalone letters ({\\ss} → ß, {\\o} → ø, {\\AA} → Å)", () => {
    expect(foldLatexAccents("{\\ss}")).toBe("{ß}");
    expect(foldLatexAccents("{\\o}")).toBe("{ø}");
    expect(foldLatexAccents("{\\O}")).toBe("{Ø}");
    expect(foldLatexAccents("{\\ae}")).toBe("{æ}");
    expect(foldLatexAccents("{\\l}")).toBe("{ł}");
    expect(foldLatexAccents("{\\AA}")).toBe("{Å}");
    expect(foldLatexAccents("{\\i}")).toBe("{ı}");
  });

  it("does not eat a longer command name as a special letter (\\oexyz)", () => {
    // \o is a special letter but \oe is a DIFFERENT one and \oex... is neither;
    // the word-boundary guard prevents \o from swallowing the following letters.
    expect(foldLatexAccents("\\oe")).toBe("œ");
    expect(foldLatexAccents("\\oexyz")).toBe("\\oexyz");
  });

  it("degrades an unmapped accent+letter by dropping the accent, keeping the letter", () => {
    expect(foldLatexAccents('\\"q')).toBe("q");
  });

  it("leaves non-accent text byte-for-byte unchanged (additive)", () => {
    expect(foldLatexAccents("Plain ASCII title, no escapes")).toBe(
      "Plain ASCII title, no escapes",
    );
    expect(foldLatexAccents("E = mc^2 with \\textbf bold")).toBe(
      "E = mc^2 with \\textbf bold",
    );
  });

  it("stays LINEAR on a hostile run of accent escapes (no quadratic blowup)", () => {
    // A crafted value of 50k `\"o` runs must fold in one linear pass, not
    // rescan-per-accent or iterate-to-stable (wave-4 SEC-22.2).
    const n = 50_000;
    const hostile = '\\"o'.repeat(n);
    const t0 = Date.now();
    const out = foldLatexAccents(hostile);
    const dt = Date.now() - t0;
    expect(out).toBe("ö".repeat(n));
    expect(dt).toBeLessThan(1000);
  });

  it("round-trips through parseBibtex into the field value", () => {
    const src = `@article{x,
      author = {M{\\"u}ller, Hans and Garc{\\'i}a, Mar{\\'i}a},
      title = {Sch{\\"o}ne Gr{\\"u}{\\ss}e},
      publisher = {{\\O}stergaard}
    }`;
    const [e] = parseBibtex(src);
    expect(e!.author).toEqual(["Müller, Hans", "García, María"]);
    expect(e!.title).toBe("Schöne Grüße");
    expect(e!.publisher).toBe("Østergaard");
  });
});

describe("makeCiteKey (determinism + collisions)", () => {
  const entry = (a?: string[], year?: string, title?: string): CitationEntry => ({
    key: "",
    type: "article",
    ...(a ? { author: a } : {}),
    ...(year ? { year } : {}),
    ...(title ? { title } : {}),
  });

  it("is deterministic: same input → same key", () => {
    const e = entry(["Müller, Anna"], "2019");
    expect(makeCiteKey(e, new Set())).toBe("muller2019");
    expect(makeCiteKey(e, new Set())).toBe("muller2019");
  });

  it("ascii-folds and lowercases the family name", () => {
    expect(makeCiteKey(entry(["Łukasiewicz, Jan"], "2000"), new Set())).toBe("lukasiewicz2000");
    expect(makeCiteKey(entry(["O'Neil, Cathy"], "2016"), new Set())).toBe("oneil2016");
  });

  it("handles 'Given Family' as well as 'Family, Given'", () => {
    expect(makeCiteKey(entry(["Jane Smith"], "2020"), new Set())).toBe("smith2020");
    expect(makeCiteKey(entry(["Smith, Jane"], "2020"), new Set())).toBe("smith2020");
  });

  it("suffixes deterministically on collision (base, then b, c, …)", () => {
    const e = entry(["Smith, Jane"], "2020");
    const existing = new Set<string>();
    const k1 = makeCiteKey(e, existing);
    existing.add(k1);
    const k2 = makeCiteKey(e, existing);
    existing.add(k2);
    const k3 = makeCiteKey(e, existing);
    expect([k1, k2, k3]).toEqual(["smith2020", "smith2020b", "smith2020c"]);
  });

  it("does not mutate the existingKeys set", () => {
    const existing = new Set<string>(["smith2020"]);
    makeCiteKey(entry(["Smith, Jane"], "2020"), existing);
    expect([...existing]).toEqual(["smith2020"]);
  });

  it("falls back to title word, then 'ref', when author/year missing", () => {
    expect(makeCiteKey(entry(undefined, undefined, "Quantum Gravity"), new Set())).toBe("quantum");
    expect(makeCiteKey(entry(), new Set())).toBe("ref");
  });
});

describe("dedupeEntries", () => {
  it("collapses by normalized DOI, first wins", () => {
    const entries: CitationEntry[] = [
      { key: "a", type: "article", doi: "10.1/X", title: "First" },
      { key: "b", type: "article", doi: "10.1/x", title: "Dup of first" },
      { key: "c", type: "article", doi: "10.2/y", title: "Other" },
    ];
    const out = dedupeEntries(entries);
    expect(out.map((e) => e.key)).toEqual(["a", "c"]);
  });

  it("collapses by normalized title+year when no DOI", () => {
    const entries: CitationEntry[] = [
      { key: "a", type: "article", title: "On the Theory!", year: "2020" },
      { key: "b", type: "article", title: "on the   theory", year: "2020" },
      { key: "c", type: "article", title: "On the Theory!", year: "2021" }, // diff year
    ];
    const out = dedupeEntries(entries);
    expect(out.map((e) => e.key)).toEqual(["a", "c"]);
  });

  it("never collapses entries without a stable identity", () => {
    const entries: CitationEntry[] = [
      { key: "a", type: "misc" },
      { key: "b", type: "misc" },
    ];
    expect(dedupeEntries(entries)).toHaveLength(2);
  });
});

describe("toHayagriva", () => {
  it("renders the key as the top-level mapping key with nested fields", () => {
    const e: CitationEntry = {
      key: "smith2020",
      type: "article",
      title: "On the Theory of Everything",
      author: ["Smith, Jane", "Doe, John"],
      year: "2020",
      journal: "Journal of Things",
      doi: "10.1000/xyz123",
    };
    const yaml = toHayagriva(e);
    expect(yaml.startsWith("smith2020:\n")).toBe(true);
    expect(yaml).toContain("  type: article");
    expect(yaml).toContain("  title: On the Theory of Everything");
    expect(yaml).toContain("  author:\n");
    // Names with a comma are NOT trivially-safe plain scalars → quoted.
    expect(yaml).toContain('    - "Smith, Jane"');
    expect(yaml).toContain('    - "Doe, John"');
    // A 4-digit year is number-like, so it is quoted to round-trip as a string.
    expect(yaml).toContain('  date: "2020"');
    // The DOI contains a slash → quoted.
    expect(yaml).toContain('    doi: "10.1000/xyz123"');
  });

  it("renders a single author inline (no list)", () => {
    const yaml = toHayagriva({ key: "k", type: "book", author: ["Knuth, Donald"] });
    // Inline (not a YAML sequence); quoted because of the comma.
    expect(yaml).toContain('  author: "Knuth, Donald"');
    expect(yaml).not.toContain("    - ");
  });

  it("quotes scalars that would break YAML", () => {
    const yaml = toHayagriva({ key: "k", type: "misc", title: "Yes: a colon" });
    expect(yaml).toContain('  title: "Yes: a colon"');
  });

  it("emits editor (single + multi) and abstract (G7)", () => {
    const single = toHayagriva({ key: "k", type: "book", editor: ["Knuth, Donald"] });
    expect(single).toContain('  editor: "Knuth, Donald"');
    expect(single).not.toContain("    - ");

    const multi = toHayagriva({
      key: "k",
      type: "incollection",
      editor: ["Smith, Jane", "Doe, John"],
      abstract: "A summary.",
    });
    expect(multi).toContain("  editor:\n");
    expect(multi).toContain('    - "Smith, Jane"');
    expect(multi).toContain('    - "Doe, John"');
    expect(multi).toContain("  abstract: A summary.");
  });

  it("omits editor/abstract when absent (additive — unchanged output)", () => {
    const yaml = toHayagriva({ key: "k", type: "misc", title: "T" });
    expect(yaml).not.toContain("editor");
    expect(yaml).not.toContain("abstract");
  });
});

describe("toHayagriva (hostile input / YAML-injection hardening)", () => {
  // Count lines that begin a NEW top-level mapping (no leading whitespace, ends
  // a `key:` mapping). For a single entry there must be exactly one.
  const topLevelKeyLines = (yaml: string): string[] =>
    yaml.split("\n").filter((l) => l.length > 0 && !/^\s/.test(l));

  it("does not let an embedded newline in the title inject a new top-level node", () => {
    const yaml = toHayagriva({ key: "k", type: "article", title: "A\n- injected" });
    // Exactly one top-level mapping key: `k:`. No `- injected` line at any level.
    expect(topLevelKeyLines(yaml)).toEqual(["k:"]);
    expect(yaml).not.toContain("\n- injected");
    // The title is a single double-quoted scalar with the newline escaped.
    expect(yaml).toContain('  title: "A\\n- injected"');
  });

  it("quotes a ` #comment` value so YAML does not truncate it", () => {
    const yaml = toHayagriva({ key: "k", type: "article", title: "x #comment" });
    expect(yaml).toContain('  title: "x #comment"');
    // Must NOT render as a bare `x` followed by a YAML comment.
    expect(yaml).not.toContain("  title: x #comment");
  });

  it("quotes YAML keyword-like values (true/null) so they round-trip as strings", () => {
    expect(toHayagriva({ key: "k", type: "misc", title: "true" })).toContain('  title: "true"');
    expect(toHayagriva({ key: "k", type: "misc", title: "null" })).toContain('  title: "null"');
    expect(toHayagriva({ key: "k", type: "misc", title: "no" })).toContain('  title: "no"');
  });

  it("quotes number-like values so they round-trip as strings", () => {
    expect(toHayagriva({ key: "k", type: "misc", title: "42" })).toContain('  title: "42"');
    expect(toHayagriva({ key: "k", type: "misc", title: "3.14" })).toContain('  title: "3.14"');
  });

  it("escapes NUL/control chars in a value (no raw control byte in output)", () => {
    const nul = String.fromCharCode(0);
    const tab = String.fromCharCode(9);
    const yaml = toHayagriva({ key: "k", type: "misc", title: `a${nul}b${tab}c` });
    // No raw NUL or raw tab leaks into the rendered YAML.
    expect(yaml).not.toContain(nul);
    expect(yaml).not.toContain(tab);
    expect(yaml).toContain('  title: "a\\u0000b\\tc"');
    expect(topLevelKeyLines(yaml)).toEqual(["k:"]);
  });

  it("quotes a malicious cite KEY (colon + newline) so it cannot inject keys", () => {
    // A crafted parsed BibTeX key that would, raw, emit two top-level mappings.
    const malicious = "safe: {}\npwned";
    const yaml = toHayagriva({ key: malicious, type: "article", title: "T" });
    // Exactly ONE top-level mapping key, and it is the quoted malicious string.
    const tops = topLevelKeyLines(yaml);
    expect(tops).toHaveLength(1);
    expect(tops[0]).toBe(`${JSON.stringify(malicious)}:`);
    expect(yaml).not.toContain("\npwned");
  });

  it("renders the full pipeline (parseBibtex → toHayagriva) without key injection", () => {
    // A BibTeX entry whose cite key tries to break out of the mapping.
    const src = '@article{evil: x\ninjected: 1, title = {Clean Title}}';
    const [e] = parseBibtex(src);
    expect(e).toBeDefined();
    const yaml = toHayagriva(e!);
    // Whatever the parser captured as the key, it renders as one quoted top-level
    // mapping — never multiple.
    const tops = yaml.split("\n").filter((l) => l.length > 0 && !/^\s/.test(l));
    expect(tops).toHaveLength(1);
    expect(tops[0]!.startsWith('"')).toBe(true);
  });
});

describe("crossrefToEntry", () => {
  it("maps a Crossref envelope to a CitationEntry", () => {
    const env: CrossrefEnvelope = {
      message: {
        DOI: "10.1038/nphys1170",
        title: ["A Great Paper"],
        author: [{ family: "Curie", given: "Marie" }, { name: "Anon Group" }],
        issued: { "date-parts": [[2008, 11]] },
        type: "journal-article",
        "container-title": ["Nature Physics"],
        volume: "4",
        page: "1-10",
      },
    };
    const e = crossrefToEntry(env);
    expect(e.type).toBe("article");
    expect(e.title).toBe("A Great Paper");
    expect(e.author).toEqual(["Curie, Marie", "Anon Group"]);
    expect(e.year).toBe("2008");
    expect(e.doi).toBe("10.1038/nphys1170");
    expect(e.journal).toBe("Nature Physics");
    expect(e.key).toBe("");
  });
});

describe("fetchCitation (injected fetch, fail-closed)", () => {
  const okEnvelope: CrossrefEnvelope = {
    message: {
      DOI: "10.1000/xyz123",
      title: ["Injected Fetch Works"],
      author: [{ family: "Lovelace", given: "Ada" }],
      issued: { "date-parts": [[1843]] },
      type: "journal-article",
    },
  };

  it("resolves a DOI via the injected fetch (never the global)", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => okEnvelope,
      } as unknown as Response;
    }) as typeof fetch;

    const entry = await fetchCitation("10.1000/xyz123", { fetch: fakeFetch });
    expect(calledUrl).toContain("api.crossref.org/works/");
    expect(calledUrl).toContain(encodeURIComponent("10.1000/xyz123"));
    expect(entry.title).toBe("Injected Fetch Works");
    expect(entry.author).toEqual(["Lovelace, Ada"]);
    expect(entry.year).toBe("1843");
  });

  it("fails closed on a non-OK response", async () => {
    const fakeFetch = (async () =>
      ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    await expect(fetchCitation("10.1000/missing", { fetch: fakeFetch })).rejects.toBeInstanceOf(
      CitationFetchError,
    );
  });

  it("fails closed on malformed JSON", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json");
        },
      }) as unknown as Response) as typeof fetch;
    await expect(fetchCitation("10.1000/xyz", { fetch: fakeFetch })).rejects.toBeInstanceOf(
      CitationFetchError,
    );
  });

  it("fails closed on a thrown network error", async () => {
    const fakeFetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(fetchCitation("10.1000/xyz", { fetch: fakeFetch })).rejects.toBeInstanceOf(
      CitationFetchError,
    );
  });

  it("rejects non-DOI/URL inputs without calling fetch", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch;
    await expect(fetchCitation("just words", { fetch: fakeFetch })).rejects.toBeInstanceOf(
      CitationFetchError,
    );
    expect(called).toBe(false);
  });

  it("fails closed (typed error, not a raw TypeError) on a null JSON body", async () => {
    const fakeFetch = (async () =>
      ({ ok: true, status: 200, json: async () => null }) as unknown as Response) as typeof fetch;
    await expect(fetchCitation("10.1000/xyz", { fetch: fakeFetch })).rejects.toBeInstanceOf(
      CitationFetchError,
    );
  });

  it("fails closed on a non-object JSON body", async () => {
    const fakeFetch = (async () =>
      ({ ok: true, status: 200, json: async () => "a string" }) as unknown as Response) as typeof fetch;
    await expect(fetchCitation("10.1000/xyz", { fetch: fakeFetch })).rejects.toBeInstanceOf(
      CitationFetchError,
    );
  });
});
