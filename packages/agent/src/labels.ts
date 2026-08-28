/**
 * Roadmap #13 — cross-reference labels: the PURE, offline, framework-free core.
 *
 * Typst cross-references: a label DEF is written `<name>` and a REF is written
 * `@name`. Label names are letters/digits/`-`/`_`/`.`/`:`. This module performs a
 * straightforward lexical scan of the raw source, recording every def and ref in
 * document order with exact absolute UTF-16 offsets (`end` exclusive — i.e.
 * `source.slice(start, end)` yields the literal token including its `<>`/`@`).
 *
 * No React, no DOM, no CodeMirror — this is a deterministic function over a string.
 *
 * SCOPING NOTE (important): `@name` is ALSO Typst's citation syntax (`@key` cites a
 * bibliography entry). This core does NOT distinguish a cross-reference from a
 * citation — `buildLabelIndex` returns ALL `@`-refs. Consequently `findBrokenRefs`
 * yields LOCAL findings only: a "broken" ref may in fact be a valid citation. The
 * coordinator composes these with the citation index before surfacing diagnostics.
 * Nothing here wires to live diagnostics.
 *
 * We keep the scan simple and lexical. We do not attempt to exclude `<...>`/`@...`
 * that appear inside code, strings, or comments — Typst markup is contextual and a
 * full parse is out of scope. (The broken-ref LINTS pre-strip comments and raw
 * blocks via `./typst-comments.js` before indexing, so a comment mentioning
 * `@preview` never reaches diagnostics; this core stays raw.) Three guards we DO
 * apply, matching Typst's lexer: a `@` must be followed by at least one
 * valid name char to count as a ref (and `<>` must enclose at least one to count
 * as a def); a ref name never ENDS with `.`/`:` — `@lightcone.` at the end
 * of a sentence is the ref `@lightcone` plus punctuation; and a BACKSLASH-ESCAPED
 * `\@` / `\<` is a literal character, so the scan skips it rather than reading a
 * ref or a def. That last one is what lets an email address written the
 * idiomatic Typst way — `jane.doe\@example.com` — stop being reported as a
 * reference to a label named `example.com`.
 *
 * UNESCAPED email-like `foo@bar` still counts its `@bar` as a ref (kept simple,
 * documented), as does an `@` inside a code-mode string such as `#"a@b"`:
 * telling markup strings (where a `@ref` is real) from code strings (where it is
 * not) needs the full parse this core deliberately avoids. Broken-ref
 * composition upstream is the place to resolve such ambiguity, not this core.
 */

export interface LabelDef {
  name: string;
  /** Absolute UTF-16 offset of the opening `<`. */
  start: number;
  /** Absolute UTF-16 offset just past the closing `>` (exclusive). */
  end: number;
}

export interface LabelRef {
  name: string;
  /** Absolute UTF-16 offset of the `@`. */
  start: number;
  /** Absolute UTF-16 offset just past the last name char (exclusive). */
  end: number;
}

export interface LabelIndex {
  defs: LabelDef[];
  refs: LabelRef[];
}

/** Valid label-name characters: letters, digits, `-`, `_`, `.`, `:`. */
const NAME_CHARS = /[\w\-.:]/;

function isNameChar(ch: string): boolean {
  return NAME_CHARS.test(ch);
}

/**
 * Parse all `<name>` defs and `@name` refs in document order with exact UTF-16
 * offsets. A single linear scan keeps offsets honest across CRLF and astral
 * characters (we index into the raw string, whose `.length` is UTF-16 units).
 */
export function buildLabelIndex(source: string): LabelIndex {
  const defs: LabelDef[] = [];
  const refs: LabelRef[] = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const ch = source[i]!;

    if (ch === "\\") {
      // Typst's markup escape: `\@` and `\<` are LITERAL characters, never a
      // ref or a label def. Skipping the escaped character is what keeps an
      // ordinary email address — `jane.doe\@example.com`, the idiomatic way to
      // write one in Typst markup — from being read as a reference to a label
      // named `example.com` and warned about on every compile.
      //
      // Skipping two characters is also correct for `\\`: the second backslash
      // is itself escaped, so a following `@` is a real ref again (`\\@fig-1`
      // is a literal backslash followed by a reference).
      i += 2;
      continue;
    }

    if (ch === "<") {
      // Scan a contiguous run of name chars, require a closing `>`.
      let j = i + 1;
      while (j < n && isNameChar(source[j]!)) j++;
      if (j > i + 1 && source[j] === ">") {
        defs.push({ name: source.slice(i + 1, j), start: i, end: j + 1 });
        i = j + 1;
        continue;
      }
    } else if (ch === "@") {
      let j = i + 1;
      while (j < n && isNameChar(source[j]!)) j++;
      // Typst's lexer: a ref name may CONTAIN `.`/`:` but never END with them —
      // `@lightcone.` at the end of a sentence is the ref `@lightcone` plus a
      // full stop, not a ref named "lightcone." (#20.2 first-boot false positive).
      while (j > i + 1 && (source[j - 1] === "." || source[j - 1] === ":")) j--;
      if (j > i + 1) {
        refs.push({ name: source.slice(i + 1, j), start: i, end: j });
        i = j;
        continue;
      }
    }

    i++;
  }

  return { defs, refs };
}

/** Refs whose name has no matching def. Each broken occurrence is reported. */
export function findBrokenRefs(index: LabelIndex): LabelRef[] {
  const defined = new Set(index.defs.map((d) => d.name));
  return index.refs.filter((r) => !defined.has(r.name));
}

/** Defs with no matching ref. */
export function findUnusedLabels(index: LabelIndex): LabelDef[] {
  const used = new Set(index.refs.map((r) => r.name));
  return index.defs.filter((d) => !used.has(d.name));
}

/** Sorted unique def names — for autocomplete. */
export function labelNames(index: LabelIndex): string[] {
  return [...new Set(index.defs.map((d) => d.name))].sort();
}
