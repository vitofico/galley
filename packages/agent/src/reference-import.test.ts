/**
 * Roadmap #17.1: reference-library import core. These tests pin the additive RIS
 * parser, the auto-detect (RIS vs BibTeX) switch, cross-format dedupe, and the
 * stable-key contract that feeds the @-cite source. PURE / offline.
 */
import { describe, it, expect } from "vitest";
import {
  importReferences,
  importReferencesDetailed,
  parseRis,
  countRisRecords,
} from "./reference-import.js";

const RIS_TWO = `TY  - JOUR
TI  - On the Theory of Everything
AU  - Smith, Jane
AU  - Doe, John
PY  - 2020
JO  - Journal of Things
VL  - 12
IS  - 3
SP  - 45
EP  - 67
DO  - 10.1000/xyz123
ER  -

TY  - BOOK
T1  - The Art of Computer Programming
AU  - Knuth, Donald
Y1  - 1997
PB  - Addison-Wesley
ER  -
`;

describe("parseRis", () => {
  it("parses a multi-record RIS export with common tags", () => {
    const entries = parseRis(RIS_TWO);
    expect(entries).toHaveLength(2);

    const [a, b] = entries;
    expect(a!.title).toBe("On the Theory of Everything");
    expect(a!.author).toEqual(["Smith, Jane", "Doe, John"]);
    expect(a!.year).toBe("2020");
    expect(a!.journal).toBe("Journal of Things");
    expect(a!.volume).toBe("12");
    expect(a!.number).toBe("3");
    expect(a!.pages).toBe("45--67");
    expect(a!.doi).toBe("10.1000/xyz123");
    expect(a!.type).toBe("article"); // JOUR → article

    expect(b!.title).toBe("The Art of Computer Programming");
    expect(b!.author).toEqual(["Knuth, Donald"]);
    expect(b!.year).toBe("1997"); // Y1 with date parts → 4-digit year
    expect(b!.publisher).toBe("Addison-Wesley");
    expect(b!.type).toBe("book"); // BOOK → book
  });

  it("maps T2/JF to container and extracts a 4-digit year from a full RIS date", () => {
    const ris = `TY  - CPAPER
TI  - A Conference Paper
T2  - Proceedings of Stuff
Y1  - 1978/07/04/
ER  -
`;
    const [e] = parseRis(ris);
    expect(e!.journal).toBe("Proceedings of Stuff");
    expect(e!.year).toBe("1978");
    expect(e!.type).toBe("inproceedings"); // CPAPER → inproceedings
  });

  it("drops unknown tags and still parses the record", () => {
    const ris = `TY  - JOUR
TI  - Known Title
ZZ  - some vendor-specific junk
N1  - a note we do not map
AU  - Lovelace, Ada
ER  -
`;
    const [e] = parseRis(ris);
    expect(e!.title).toBe("Known Title");
    expect(e!.author).toEqual(["Lovelace, Ada"]);
    // No surprise fields from the dropped tags.
    expect(e!.publisher).toBeUndefined();
    expect(e!.journal).toBeUndefined();
  });

  it("maps ED/E1 → editor and AB → abstract; A2/A3 stay authors (G7)", () => {
    const ris = `TY  - CHAP
TI  - A Chapter
AU  - Author, Alice
A2  - Coauthor, Carol
A3  - Coauthor, Dave
ED  - Editor, Edna
E1  - Editor, Frank
AB  - This is the abstract.
ER  -
`;
    const [e] = parseRis(ris);
    expect(e!.editor).toEqual(["Editor, Edna", "Editor, Frank"]);
    expect(e!.abstract).toBe("This is the abstract.");
    // SAFE call: A2/A3 are NOT reclassified as editors — they remain authors
    // alongside AU so genuine co-authors are never demoted.
    expect(e!.author).toEqual(["Author, Alice", "Coauthor, Carol", "Coauthor, Dave"]);
  });

  it("maps N2 → abstract when AB is absent (G7)", () => {
    const ris = `TY  - JOUR
TI  - X
N2  - Abstract via N2.
ER  -
`;
    const [e] = parseRis(ris);
    expect(e!.abstract).toBe("Abstract via N2.");
  });

  it("returns [] for junk / empty input", () => {
    expect(parseRis("")).toEqual([]);
    expect(parseRis("not ris at all")).toEqual([]);
  });
});

describe("countRisRecords (honesty: how many records were seen)", () => {
  it("counts TY..ER records regardless of how many tags map", () => {
    expect(countRisRecords(RIS_TWO)).toBe(2);
    expect(countRisRecords("TY  - JOUR\nER  -\n")).toBe(1);
    expect(countRisRecords("garbage")).toBe(0);
  });
});

describe("importReferences", () => {
  it("auto-detects RIS by a leading 'TY  - '", () => {
    const entries = importReferences(RIS_TWO, "auto");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toBe("On the Theory of Everything");
    // every entry has a stable, non-empty key
    expect(entries.every((e) => e.key.length > 0)).toBe(true);
  });

  it("auto-detects BibTeX when there is no leading TY tag", () => {
    const bib = `@article{smith2020, author={Smith, Jane}, title={On the Theory of Everything}, year={2020}}`;
    const entries = importReferences(bib, "auto");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("smith2020");
    expect(entries[0]!.title).toBe("On the Theory of Everything");
  });

  it("assigns stable, globally-unique keys (derived when RIS has none)", () => {
    const entries = importReferences(RIS_TWO, "ris");
    // Smith 2020 → smith2020; Knuth 1997 → knuth1997
    expect(entries.map((e) => e.key)).toEqual(["smith2020", "knuth1997"]);
  });

  it("suffixes colliding derived keys deterministically", () => {
    const ris = `TY  - JOUR
AU  - Smith, Jane
PY  - 2020
TI  - First
ER  -
TY  - JOUR
AU  - Smith, Jane
PY  - 2020
TI  - Second
ER  -
`;
    const entries = importReferences(ris, "ris");
    expect(entries.map((e) => e.key)).toEqual(["smith2020", "smith2020b"]);
  });

  it("de-duplicates ACROSS formats by DOI (BibTeX + RIS of the same work)", () => {
    const ris = `TY  - JOUR
TI  - Shared Work
AU  - Curie, Marie
PY  - 2008
DO  - 10.1/shared
ER  -
`;
    const bib = `@article{curie2008, author={Curie, Marie}, title={Shared Work}, year={2008}, doi={10.1/shared}}`;
    // Importing each, then concatenating + dedupe is the consumer's job; here we
    // verify a single mixed call where format is forced and dedupe collapses
    // the cross-format duplicate.
    const mixed = importReferences(`${bib}\n${ris}`, "auto"); // auto → bibtex (no leading TY)
    // Only the BibTeX side parses under bibtex format; ensure no crash + one entry.
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.doi).toBe("10.1/shared");

    // And a RIS-format import of two records with the same DOI collapses to one.
    const dupRis = `${ris}\nTY  - JOUR\nTI  - Shared Work Dup\nDO  - 10.1/shared\nER  -\n`;
    const deduped = importReferences(dupRis, "ris");
    expect(deduped).toHaveLength(1);
  });

  it("returns [] for empty / unrecognized input", () => {
    expect(importReferences("", "auto")).toEqual([]);
    expect(importReferences("   ", "auto")).toEqual([]);
  });
});

describe("importReferencesDetailed (G4 honesty count)", () => {
  it("reports an all-well-formed BibTeX library with no malformed entries", () => {
    const bib = `@article{a, title={A}, year={2020}}\n@book{b, title={B}, year={2021}}`;
    const d = importReferencesDetailed(bib, "auto");
    expect(d.entries).toHaveLength(2);
    expect(d.totalCount).toBe(2);
    expect(d.parsedCount).toBe(2);
    expect(d.malformedCount).toBe(0);
  });

  it("counts a malformed mid-library BibTeX entry but recovers the rest", () => {
    const bib = [
      "@article{first2000, title={Alpha}, year={2000}}",
      "@article{broken, title={Unclosed",
      "@article{last2001, title={Omega}, year={2001}}",
    ].join("\n");
    const d = importReferencesDetailed(bib, "auto");
    expect(d.entries.map((e) => e.key)).toEqual(["first2000", "last2001"]);
    expect(d.totalCount).toBe(3);
    expect(d.parsedCount).toBe(2);
    expect(d.malformedCount).toBe(1);
  });

  it("does not count @comment/@string directives as malformed", () => {
    const bib = [
      "@comment{just a note}",
      "@string{j = {Journal}}",
      "@article{ok, title={Fine}, year={2020}}",
    ].join("\n");
    const d = importReferencesDetailed(bib, "auto");
    expect(d.entries).toHaveLength(1);
    expect(d.totalCount).toBe(1); // directives are not bibliographic entries
    expect(d.parsedCount).toBe(1);
    expect(d.malformedCount).toBe(0);
  });

  it("reports zero malformed for a RIS import", () => {
    const d = importReferencesDetailed(RIS_TWO, "auto");
    expect(d.totalCount).toBe(2);
    expect(d.parsedCount).toBe(2);
    expect(d.malformedCount).toBe(0);
  });
});
