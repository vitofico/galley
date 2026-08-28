/**
 * Roadmap #6 (feed): bibliography → cite-key pipeline. These tests pin the
 * composition over the citation core: parse a BibTeX LIBRARY string, dedupe it,
 * and ensure every entry ends up with a stable, unique, non-empty cite key in
 * source order — which is exactly what the `@`-cite autocomplete + ref-check
 * consume. Pure, offline, framework-free (matches citation.test.ts style).
 */
import { describe, it, expect } from "vitest";
import { parseBibliography, citeKeysFromBibliography } from "./bibliography.js";
import { parseBibtex, makeCiteKey } from "./citation.js";

describe("parseBibliography", () => {
  it("parses a multi-entry library into ordered, keyed entries", () => {
    const src = `
      @article{smith2020, author = {Smith, Jane}, title = {On Things}, year = {2020}, doi = {10.1/aaa}}
      @book{jones2019, author = {Jones, Bob}, title = {A Book}, year = {2019}}
      @misc{web1, title = {A Web Page}, year = {2021}, url = {https://example.com}}
    `;
    const entries = parseBibliography(src);
    expect(entries.map((e) => e.key)).toEqual(["smith2020", "jones2019", "web1"]);
    // Source order is preserved and metadata survives.
    expect(entries[0]!.title).toBe("On Things");
    expect(entries[1]!.type).toBe("book");
  });

  it("preserves an explicit BibTeX citekey verbatim", () => {
    const src = `@article{MyCustomKey, author = {Lee, Amy}, title = {Paper}, year = {2022}}`;
    const entries = parseBibliography(src);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("MyCustomKey");
  });

  it("collapses duplicate entries by DOI", () => {
    const src = `
      @article{a, author = {Smith, Jane}, title = {On Things}, year = {2020}, doi = {10.1/dup}}
      @article{b, author = {Smith, Jane}, title = {On Things (reprint)}, year = {2021}, doi = {10.1/DUP}}
    `;
    const entries = parseBibliography(src);
    expect(entries).toHaveLength(1);
    // First occurrence wins (its key is preserved).
    expect(entries[0]!.key).toBe("a");
  });

  it("collapses duplicate entries by title+year when no DOI", () => {
    const src = `
      @article{first, author = {Doe, Ann}, title = {Same Title}, year = {2018}}
      @article{second, author = {Doe, Ann}, title = {Same Title}, year = {2018}}
    `;
    const entries = parseBibliography(src);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("first");
  });

  it("assigns a deterministic stable key to entries with an empty citekey", () => {
    // No citekey in the @article{...} header (comma right after the brace).
    const src = `@article{, author = {Hopper, Grace}, title = {Compilers}, year = {1952}}`;
    const entries = parseBibliography(src);
    expect(entries).toHaveLength(1);
    // makeCiteKey of this entry on an empty key set is the expected stable key.
    const expected = makeCiteKey(parseBibtex(src)[0]!, new Set<string>());
    expect(entries[0]!.key).toBe(expected);
    expect(entries[0]!.key.length).toBeGreaterThan(0);
    expect(entries[0]!.key).toBe("hopper1952");
  });

  it("deterministically suffixes two entries that would share a base key", () => {
    // Two distinct papers, same author+year, both missing a citekey → same base.
    const src = `
      @article{, author = {Turing, Alan}, title = {Machinery}, year = {1950}}
      @article{, author = {Turing, Alan}, title = {Numbers}, year = {1950}}
    `;
    const entries = parseBibliography(src);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.key).toBe("turing1950");
    expect(entries[1]!.key).toBe("turing1950b");
    // Keys are distinct.
    expect(entries[0]!.key).not.toBe(entries[1]!.key);
  });

  it("deterministically suffixes a provided citekey that collides with an earlier one", () => {
    const src = `
      @article{dup, author = {A, B}, title = {First}, year = {2001}}
      @article{dup, author = {C, D}, title = {Second}, year = {2002}}
    `;
    const entries = parseBibliography(src);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.key).toBe("dup");
    expect(entries[1]!.key).toBe("dupb");
  });

  it("falls back to a non-empty key for an entry with neither author nor title", () => {
    const src = `@misc{, year = {2000}}`;
    const entries = parseBibliography(src);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key.length).toBeGreaterThan(0);
    expect(entries[0]!.key).toBe("ref2000");
  });

  it("returns [] for empty input", () => {
    expect(parseBibliography("")).toEqual([]);
    expect(parseBibliography("   \n  ")).toEqual([]);
  });

  it("returns [] for garbage / non-bibliography input", () => {
    expect(parseBibliography("just some prose with no entries")).toEqual([]);
    expect(parseBibliography("@comment{ignored} @string{x = {y}}")).toEqual([]);
  });

  it("produces globally unique keys across the whole library", () => {
    const src = `
      @article{, author = {Knuth, Donald}, title = {Art 1}, year = {1968}}
      @article{, author = {Knuth, Donald}, title = {Art 2}, year = {1968}}
      @article{, author = {Knuth, Donald}, title = {Art 3}, year = {1968}}
    `;
    const keys = parseBibliography(src).map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["knuth1968", "knuth1968b", "knuth1968c"]);
  });
});

describe("citeKeysFromBibliography", () => {
  it("returns just the ordered key list", () => {
    const src = `
      @article{smith2020, author = {Smith, Jane}, title = {On Things}, year = {2020}}
      @book{jones2019, author = {Jones, Bob}, title = {A Book}, year = {2019}}
    `;
    expect(citeKeysFromBibliography(src)).toEqual(["smith2020", "jones2019"]);
  });

  it("matches the keys of parseBibliography exactly", () => {
    const src = `
      @article{, author = {Turing, Alan}, title = {Machinery}, year = {1950}}
      @article{, author = {Turing, Alan}, title = {Numbers}, year = {1950}}
      @misc{web, title = {Page}, url = {https://example.com}}
    `;
    const fromEntries = parseBibliography(src).map((e) => e.key);
    expect(citeKeysFromBibliography(src)).toEqual(fromEntries);
  });

  it("returns [] for empty / garbage input", () => {
    expect(citeKeysFromBibliography("")).toEqual([]);
    expect(citeKeysFromBibliography("nonsense")).toEqual([]);
  });
});
