/**
 * First-boot lint fix (#20.2) — a small, PURE Typst comment/raw stripper local
 * to the broken-ref lint (`./ref-check.js`, `./cross-file-labels.js`).
 *
 * The label core (`./labels.js`) is a deliberately lexical scan: it reads
 * `@name` / `<name>` anywhere in the raw source, including inside comments —
 * so a header comment mentioning `@preview` produced a bogus "unknown
 * reference" warning on the demo workspace's very first boot. This module
 * blanks the regions Typst never treats as markup before that scan runs:
 *
 *   - `// …` line comments (outside strings/raw),
 *   - slash-star block comments, NESTED as Typst nests them,
 *   - raw content (`` `…` `` inline and ``` fenced ```), where `@`/`<>` are
 *     literal text.
 *
 * OFFSET CONTRACT: the output has the SAME length as the input and every `\n`
 * is preserved in place — stripped characters become spaces. A label index
 * built over the stripped text therefore carries offsets/lines/columns that
 * are exactly valid in the ORIGINAL text, so diagnostic spans are unaffected.
 *
 * Scope honesty: Typst comment rules are contextual (markup vs code mode) and
 * a full parse is out of scope, exactly as documented in `./labels.js`. The
 * two deliberate approximations:
 *   - `"…"` is tracked as a string (with `\` escapes) so a URL like
 *     `"https://…"` never starts a line comment. String state resets at a
 *     newline, so an unmatched markup quote can at worst mask one line.
 *   - String CONTENT is left untouched (refs inside strings were visible to
 *     the scan before; this module only fixes the comment/raw false positives).
 *
 * No React, no DOM, no I/O — a deterministic function over a string.
 */

/**
 * Blank Typst comments and raw-block content with spaces, preserving the
 * source length and every newline (see the offset contract above).
 */
export function stripTypstComments(source: string): string {
  const n = source.length;
  const out = source.split("");
  /** Blank one char unless it is a newline (newlines keep lines aligned). */
  const blank = (k: number): void => {
    if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };

  let i = 0;
  let blockDepth = 0; // `/* … */` nesting depth (Typst block comments nest)
  let rawFence = 0; // length of the opening backtick run when inside raw, else 0
  let inString = false; // inside a `"…"` literal (escape-aware, line-local)

  while (i < n) {
    const ch = source[i]!;

    if (blockDepth > 0) {
      if (ch === "/" && source[i + 1] === "*") {
        blockDepth++;
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (ch === "*" && source[i + 1] === "/") {
        blockDepth--;
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }

    if (rawFence > 0) {
      if (ch === "`") {
        let j = i;
        while (j < n && source[j] === "`") j++;
        if (j - i >= rawFence) {
          rawFence = 0; // closing run (>= the opener, as Typst matches fences)
          i = j;
          continue;
        }
        for (let k = i; k < j; k++) blank(k); // shorter run: still raw content
        i = j;
        continue;
      }
      blank(i);
      i++;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        i += 2; // escaped char (incl. \") stays in the string
        continue;
      }
      if (ch === '"' || ch === "\n") inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (j < n && source[j] === "`") j++;
      const run = j - i;
      // `` `` (exactly two backticks) is Typst's EMPTY inline raw — nothing to
      // blank, and entering raw state on it would swallow the rest of the doc.
      if (run !== 2) rawFence = run;
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") {
        blank(i);
        i++;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      blockDepth = 1;
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }

    i++;
  }

  return out.join("");
}
