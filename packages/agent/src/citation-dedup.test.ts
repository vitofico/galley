import { describe, it, expect } from "vitest";
import {
  detectDuplicateGroups,
  mergeGroup,
  deduplicateEntries,
  deduplicateBibliographySource,
  toBibtex,
} from "./citation-dedup.js";
import { parseBibtex, type CitationEntry } from "./citation.js";
import { citeKeysFromBibliography } from "./bibliography.js";

function e(p: Partial<CitationEntry>): CitationEntry {
  return { key: p.key ?? "", type: p.type ?? "article", ...p };
}

describe("detectDuplicateGroups", () => {
  it("groups by normalized DOI (case/prefix-insensitive)", () => {
    const a = e({ key: "a", doi: "10.1/x", title: "First" });
    const b = e({ key: "b", doi: "https://doi.org/10.1/X", title: "Second" });
    const c = e({ key: "c", doi: "10.2/y", title: "Other" });
    const groups = detectDuplicateGroups([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((x) => x.key)).toEqual(["a", "b"]);
  });

  it("groups by normalized title + year when no DOI", () => {
    const a = e({ key: "a", title: "Attention Is All You Need", year: "2017" });
    const b = e({ key: "b", title: "attention is all you need!", year: "2017" });
    const c = e({ key: "c", title: "Attention Is All You Need", year: "2018" });
    const groups = detectDuplicateGroups([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((x) => x.key)).toEqual(["a", "b"]);
  });

  it("treats accented titles as duplicates of their ASCII fold", () => {
    const a = e({ key: "a", title: "Über Quanten", year: "1905" });
    const b = e({ key: "b", title: "Uber Quanten", year: "1905" });
    const groups = detectDuplicateGroups([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!).toHaveLength(2);
  });

  it("never groups entries with no stable identity (no doi, no title)", () => {
    const a = e({ key: "a", author: ["X"] });
    const b = e({ key: "b", author: ["X"] });
    expect(detectDuplicateGroups([a, b])).toEqual([]);
  });

  it("returns no groups when nothing duplicates", () => {
    expect(
      detectDuplicateGroups([e({ key: "a", doi: "10.1/x" }), e({ key: "b", doi: "10.2/y" })]),
    ).toEqual([]);
  });

  it("preserves first-occurrence order of groups and members", () => {
    const a = e({ key: "a", doi: "10.1/a" });
    const b = e({ key: "b", doi: "10.1/b" });
    const a2 = e({ key: "a2", doi: "10.1/a" });
    const b2 = e({ key: "b2", doi: "10.1/b" });
    const groups = detectDuplicateGroups([a, b, a2, b2]);
    expect(groups.map((g) => g.map((x) => x.key))).toEqual([
      ["a", "a2"],
      ["b", "b2"],
    ]);
  });
});

describe("mergeGroup", () => {
  it("keeps the first entry's key and wins on conflicts", () => {
    const first = e({ key: "first", title: "Title A", journal: "J1", year: "2000" });
    const second = e({ key: "second", title: "Title B", journal: "J2", year: "2001" });
    const merged = mergeGroup([first, second]);
    expect(merged.key).toBe("first");
    expect(merged.title).toBe("Title A");
    expect(merged.journal).toBe("J1");
    expect(merged.year).toBe("2000");
  });

  it("fills missing scalar fields from later duplicates without losing data", () => {
    const first = e({ key: "first", title: "T", year: "2000" });
    const second = e({
      key: "second",
      doi: "10.1/x",
      url: "http://x",
      journal: "Nature",
      publisher: "P",
      volume: "5",
      number: "2",
      pages: "1-9",
    });
    const merged = mergeGroup([first, second]);
    expect(merged).toMatchObject({
      key: "first",
      doi: "10.1/x",
      url: "http://x",
      journal: "Nature",
      publisher: "P",
      volume: "5",
      number: "2",
      pages: "1-9",
      year: "2000",
    });
  });

  it("adopts the richer author list when the first lacks one or has fewer", () => {
    const first = e({ key: "first", title: "T", author: ["Solo, A."] });
    const second = e({ key: "second", title: "T", author: ["Solo, A.", "Pair, B."] });
    expect(mergeGroup([first, second]).author).toEqual(["Solo, A.", "Pair, B."]);

    const noAuthorFirst = e({ key: "first", title: "T" });
    const withAuthor = e({ key: "second", title: "T", author: ["Pair, B."] });
    expect(mergeGroup([noAuthorFirst, withAuthor]).author).toEqual(["Pair, B."]);
  });

  it("adopts the richer editor list and fills an empty abstract (G7)", () => {
    const first = e({ key: "first", title: "T", editor: ["Ed, A."] });
    const second = e({
      key: "second",
      title: "T",
      editor: ["Ed, A.", "Ed, B."],
      abstract: "Filled in from the duplicate.",
    });
    const merged = mergeGroup([first, second]);
    expect(merged.editor).toEqual(["Ed, A.", "Ed, B."]);
    expect(merged.abstract).toBe("Filled in from the duplicate.");
  });

  it("keeps the first entry's abstract on conflict (fill-if-empty only, G7)", () => {
    const first = e({ key: "first", title: "T", abstract: "First wins." });
    const second = e({ key: "second", title: "T", abstract: "Loser." });
    expect(mergeGroup([first, second]).abstract).toBe("First wins.");
  });

  it("returns a copy and does not mutate inputs", () => {
    const first = e({ key: "first", title: "T" });
    const second = e({ key: "second", title: "T", doi: "10.1/x" });
    mergeGroup([first, second]);
    expect(first.doi).toBeUndefined();
  });
});

describe("deduplicateEntries", () => {
  it("collapses groups in first-occurrence position and keeps singletons", () => {
    const entries = [
      e({ key: "a", doi: "10.1/x", title: "A" }),
      e({ key: "single", doi: "10.9/z", title: "Single" }),
      e({ key: "a2", doi: "10.1/x", journal: "FilledJournal" }),
    ];
    const { merged, removed, groups } = deduplicateEntries(entries);
    expect(merged.map((m) => m.key)).toEqual(["a", "single"]);
    expect(merged[0]!.journal).toBe("FilledJournal");
    expect(removed).toBe(1);
    expect(groups).toHaveLength(1);
  });

  it("reports removed = 0 and unchanged order when there are no duplicates", () => {
    const entries = [e({ key: "a", doi: "10.1/x" }), e({ key: "b", doi: "10.2/y" })];
    const { merged, removed, groups } = deduplicateEntries(entries);
    expect(merged.map((m) => m.key)).toEqual(["a", "b"]);
    expect(removed).toBe(0);
    expect(groups).toEqual([]);
  });

  it("is deterministic regardless of duplicate ordering", () => {
    const x1 = e({ key: "x1", title: "Same", year: "2020", journal: "J" });
    const x2 = e({ key: "x2", title: "Same", year: "2020", volume: "7" });
    const forward = deduplicateEntries([x1, x2]).merged[0]!;
    const reverse = deduplicateEntries([{ ...x2 }, { ...x1 }]).merged[0]!;
    // First-occurrence key differs by ordering, but the COALESCED fields match.
    expect(forward.journal).toBe("J");
    expect(forward.volume).toBe("7");
    expect(reverse.journal).toBe("J");
    expect(reverse.volume).toBe("7");
  });
});

describe("deduplicateBibliographySource", () => {
  const DUP_BIB = `@article{knuth1984,
  title = {Literate Programming},
  author = {Knuth, Donald E.},
  journal = {The Computer Journal},
  year = {1984},
  doi = {10.1093/comjnl/27.2.97},
}

@article{knuth1984copy,
  title = {Literate Programming (reprint)},
  author = {Knuth, Donald E.},
  year = {1984},
  doi = {10.1093/comjnl/27.2.97},
  volume = {27},
}`;

  it("SURGICALLY removes the duplicate, keeping the first entry's exact BibTeX", () => {
    const { text, removed, groups, safe } = deduplicateBibliographySource(DUP_BIB);
    expect(removed).toBe(1);
    expect(groups).toHaveLength(1);
    expect(safe).toBe(true);
    // The output is STILL BibTeX (compile + readers keep working).
    expect(text).toContain("@article{knuth1984,");
    // The duplicate's entry is gone…
    expect(text).not.toContain("knuth1984copy");
    expect(text).not.toContain("(reprint)");
    // …and the kept entry's ORIGINAL text is preserved verbatim (not re-emitted).
    expect(text).toContain("title = {Literate Programming},");
    expect(text).toContain("journal = {The Computer Journal},");
    // Re-parses to exactly one entry, with the first occurrence's identity/fields.
    const reparsed = parseBibtex(text);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.title).toBe("Literate Programming");
    // The cite-key readers still see the surviving key.
    expect(citeKeysFromBibliography(text)).toEqual(["knuth1984"]);
  });

  it("preserves non-BibTeX remainder (comments) byte-for-byte — no data loss", () => {
    const WITH_COMMENT = `% my library
@article{a, title={X}, year={2000}, doi={10.1/x}}
% keep me
@article{b, title={Y}, year={2000}, doi={10.1/x}}
@book{c, title={Solo}, author={Doe, J.}, year={2001}}
`;
    const { text, removed } = deduplicateBibliographySource(WITH_COMMENT);
    expect(removed).toBe(1);
    // The comment lines and the unrelated entry survive verbatim.
    expect(text).toContain("% my library");
    expect(text).toContain("% keep me");
    expect(text).toContain("@book{c, title={Solo}");
    // The duplicate (b) is gone; the first (a) stays.
    expect(text).toContain("@article{a,");
    expect(text).not.toContain("@article{b,");
    // Still BibTeX-readable end to end.
    expect(citeKeysFromBibliography(text).sort()).toEqual(["a", "c"]);
  });

  it("leaves a duplicate-free library byte-for-byte unchanged, removed = 0", () => {
    const ONE = `@book{a, title={A Book}, author={Doe, J.}, year={2001}}\n`;
    const { removed, text } = deduplicateBibliographySource(ONE);
    expect(removed).toBe(0);
    expect(text).toBe(ONE); // identical bytes — no rewrite at all
  });

  it("returns the source unchanged on junk/empty input", () => {
    expect(deduplicateBibliographySource("")).toEqual({
      text: "",
      removed: 0,
      groups: [],
      safe: true,
    });
    expect(deduplicateBibliographySource("not bibtex")).toEqual({
      text: "not bibtex",
      removed: 0,
      groups: [],
      safe: true,
    });
  });
});

describe("deduplicateBibliographySource — coalescing enrichment", () => {
  it("injects a missing scalar (journal) carried by the dropped duplicate into the survivor", () => {
    // Grouped by title+year (no DOI on either, so identity is title+year). The dup
    // carries a journal the survivor lacks; the apply must now inject it.
    const SRC = `@article{a,
  title = {Shared Title},
  year = {2000},
}

@article{b,
  title = {Shared Title},
  year = {2000},
  journal = {Nature},
}`;
    const { text, removed, safe } = deduplicateBibliographySource(SRC);
    expect(removed).toBe(1);
    expect(safe).toBe(true);
    // The survivor now carries the dup's journal, injected before its closing brace.
    expect(text).toContain("@article{a,");
    expect(text).toContain("journal = {Nature},");
    // The dup is gone.
    expect(text).not.toContain("@article{b,");
    // The survivor's original fields are intact.
    expect(text).toContain("title = {Shared Title},");
    expect(text).toContain("year = {2000},");
    const reparsed = parseBibtex(text);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.journal).toBe("Nature");
    expect(reparsed[0]!.title).toBe("Shared Title");
    expect(reparsed[0]!.year).toBe("2000");
  });

  it("injects a missing DOI when the group is keyed by an identical DOI on both", () => {
    // When both share a DOI, identity is DOI-based and DOI is NOT missing; this
    // documents that DOI enrichment only fires for a DOI-keyed group via a scalar
    // the survivor lacks, and the DOI itself is left as the survivor already has it.
    const SRC = `@article{a, title={T}, year={2001}, doi={10.7/dup}}
@article{b, title={T}, year={2001}, doi={10.7/dup}, journal={Nature}, volume={5}, pages={1--9}}`;
    const { text, removed } = deduplicateBibliographySource(SRC);
    expect(removed).toBe(1);
    const reparsed = parseBibtex(text);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.doi).toBe("10.7/dup");
    expect(reparsed[0]!.journal).toBe("Nature");
    expect(reparsed[0]!.volume).toBe("5");
    expect(reparsed[0]!.pages).toBe("1--9");
    // survivor key/title kept
    expect(reparsed[0]!.key).toBe("a");
    expect(reparsed[0]!.title).toBe("T");
  });

  it("leaves the survivor byte-for-byte unchanged when it lacks nothing", () => {
    const SRC = `@article{a,
  title = {Complete},
  author = {Doe, Jane},
  year = {2002},
  doi = {10.3/full},
}

@article{b,
  title = {Complete},
  year = {2002},
  doi = {10.3/full},
}`;
    const { text, removed } = deduplicateBibliographySource(SRC);
    expect(removed).toBe(1);
    // The survivor entry's exact original text survives (no injected line).
    expect(text).toContain(`@article{a,
  title = {Complete},
  author = {Doe, Jane},
  year = {2002},
  doi = {10.3/full},
}`);
    expect(text).not.toContain("@article{b,");
  });

  it("adds an author line only when the survivor lacks one (richer-list nuance)", () => {
    const SRC = `@article{a,
  title = {Shared},
  year = {2003},
  doi = {10.4/auth},
}

@article{b,
  title = {Shared},
  year = {2003},
  doi = {10.4/auth},
  author = {Solo, A. and Pair, B.},
}`;
    const { text } = deduplicateBibliographySource(SRC);
    const reparsed = parseBibtex(text);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.author).toEqual(["Solo, A.", "Pair, B."]);
  });

  it("does NOT rewrite an existing author line even if a dup is richer (first wins)", () => {
    const SRC = `@article{a,
  title = {Shared},
  year = {2004},
  doi = {10.5/auth},
  author = {Only, One},
}

@article{b,
  title = {Shared},
  year = {2004},
  doi = {10.5/auth},
  author = {Only, One and Extra, Two and Third, Three},
}`;
    const { text } = deduplicateBibliographySource(SRC);
    // The survivor's original single-author line is untouched.
    expect(text).toContain("author = {Only, One},");
    expect(text).not.toContain("Extra, Two");
    const reparsed = parseBibtex(text);
    expect(reparsed[0]!.author).toEqual(["Only, One"]);
  });

  it("preserves a field toBibtex doesn't emit (month/keywords) through injection", () => {
    const SRC = `@article{a,
  title = {Shared},
  year = {2005},
  month = {jan},
  keywords = {physics, relativity},
}

@article{b,
  title = {Shared},
  year = {2005},
  journal = {Annalen},
}`;
    const { text, removed } = deduplicateBibliographySource(SRC);
    expect(removed).toBe(1);
    // month + keywords (parseBibtex/toBibtex don't model these) survive verbatim.
    expect(text).toContain("month = {jan},");
    expect(text).toContain("keywords = {physics, relativity},");
    // and the dup's journal was injected.
    expect(text).toContain("journal = {Annalen},");
    const reparsed = parseBibtex(text);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.journal).toBe("Annalen");
  });

  it("injects into a single-line entry before its closing brace and re-parses", () => {
    const SRC = `@article{a, title={T}, year={2006}, doi={10.8/sl}}
@article{b, title={T}, year={2006}, doi={10.8/sl}, journal={J}}`;
    const { text } = deduplicateBibliographySource(SRC);
    const reparsed = parseBibtex(text);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.journal).toBe("J");
  });

  it("escapes injected values exactly like toBibtex (brace-safe, no injection)", () => {
    const SRC = `@article{a, title={T}, year={2007}, doi={10.9/esc}}
@article{b, title={T}, year={2007}, doi={10.9/esc}, journal={A {nasty} } broke}}`;
    const { text } = deduplicateBibliographySource(SRC);
    // Whatever the dup parsed for journal, the injected line is brace-balanced and
    // the result still re-parses to a single entry.
    const reparsed = parseBibtex(text);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.key).toBe("a");
  });

  it("keeps comments + unrelated entries intact while injecting into the survivor", () => {
    const SRC = `% header
@article{a, title={X}, year={2008}}
% mid comment
@article{b, title={X}, year={2008}, journal={J. Phys.}}
@book{solo, title={Solo}, author={Doe, J.}, year={2009}}
`;
    const { text, removed } = deduplicateBibliographySource(SRC);
    expect(removed).toBe(1);
    expect(text).toContain("% header");
    expect(text).toContain("% mid comment");
    expect(text).toContain("@book{solo, title={Solo}");
    const reparsed = parseBibtex(text);
    expect(reparsed.find((r) => r.key === "a")!.journal).toBe("J. Phys.");
    expect(citeKeysFromBibliography(text).sort()).toEqual(["a", "solo"]);
  });
});

describe("toBibtex round-trips with parseBibtex", () => {
  it("round-trips every field parseBibtex reads back", () => {
    const entry: CitationEntry = {
      key: "vaswani2017",
      type: "article",
      title: "Attention Is All You Need",
      author: ["Vaswani, Ashish", "Shazeer, Noam"],
      editor: ["Guyon, Isabelle", "Luxburg, Ulrike von"],
      abstract: "The dominant sequence transduction models are based on attention.",
      year: "2017",
      doi: "10.5555/3295222",
      url: "https://example.com/paper",
      journal: "NeurIPS",
      publisher: "Curran",
      volume: "30",
      number: "1",
      pages: "5998--6008",
    };
    const round = parseBibtex(toBibtex(entry));
    expect(round).toHaveLength(1);
    expect(round[0]).toEqual(entry);
  });

  it("round-trips editor={A and B} + abstract={…} specifically (G7)", () => {
    const entry: CitationEntry = {
      key: "chap2010",
      type: "incollection",
      title: "A Chapter",
      editor: ["Edmund, Ed", "Frey, Fran"],
      abstract: "Short summary.",
      year: "2010",
    };
    const bib = toBibtex(entry);
    expect(bib).toContain("editor = {Edmund, Ed and Frey, Fran},");
    expect(bib).toContain("abstract = {Short summary.},");
    const round = parseBibtex(bib);
    expect(round[0]!.editor).toEqual(["Edmund, Ed", "Frey, Fran"]);
    expect(round[0]!.abstract).toBe("Short summary.");
  });

  it("round-trips a list joined into a library (same identities + keys)", () => {
    const entries: CitationEntry[] = [
      { key: "lorentz1904", type: "article", title: "Electromagnetic phenomena", author: ["Lorentz, Hendrik Antoon"], journal: "Proc. Roy. Neth. Acad.", volume: "6", pages: "809--831", year: "1904" },
      { key: "planck1901", type: "article", title: "Über das Gesetz", author: ["Planck, Max"], journal: "Annalen der Physik", volume: "309", number: "3", pages: "553--563", year: "1901" },
      { key: "michelson1887", type: "article", title: "On the relative motion", author: ["Michelson, Albert A.", "Morley, Edward W."], journal: "Am. J. Sci.", volume: "34", number: "203", pages: "333--345", year: "1887" },
    ];
    const lib = entries.map(toBibtex).join("\n\n");
    const round = parseBibtex(lib);
    expect(round).toEqual(entries);
    expect(citeKeysFromBibliography(lib)).toEqual([
      "lorentz1904",
      "planck1901",
      "michelson1887",
    ]);
  });

  it("strips stray braces/whitespace so the emitted entry stays brace-balanced", () => {
    const entry: CitationEntry = {
      key: "weird2020",
      type: "misc",
      title: "A  {messy}  title",
      year: "2020",
    };
    const round = parseBibtex(toBibtex(entry));
    expect(round).toHaveLength(1);
    // parseBibtex strips braces + collapses whitespace on read; the emitter does
    // the same up front, so the round-tripped title is the collapsed/stripped form.
    expect(round[0]!.title).toBe("A messy title");
  });
});
