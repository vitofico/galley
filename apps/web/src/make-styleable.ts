/**
 * make-styleable — a PURE transform that lifts a non-conforming, inline-styled
 * Typst document into the canonical Galley style ABI (see {@link
 * detectStyleability}). It targets the COMMON case the Einstein demo was hand-
 * converted from: a `/main.typ` that opens with a contiguous run of top-level
 * styling directives (`#set …`, `#show heading…`, `#let <token> = <color>`)
 * followed by body content. The transform moves that leading block into a fresh
 * `/style.typ` `doc(…)` and rewrites `/main.typ` to `#import` + `#show:
 * doc.with()` + the surviving body.
 *
 * It is deliberately NOT a general Typst parser: it recognises only the well-
 * defined leading-styling shape and FAILS CLEANLY (`ok: false` + `reason`) on
 * anything outside it (an already-conforming doc, or a doc with no liftable
 * leading styling). The pre-commit trial-compile (apply-style.ts) remains the
 * authority for whether the lifted output actually compiles — this transform's
 * own bar is that `detectStyleability(result.mainText)` reports `clean`/
 * `shimmed`.
 *
 * No DOM/worker/yjs imports. Imports from ./style-manifest.js only, to verify
 * its own output against the contract it targets.
 */
import { detectStyleability, CANONICAL_TOKENS } from "./style-manifest.js";

export interface MakeStyleableInput {
  /** The current `/main.typ` source. */
  mainText: string;
}
export type MakeStyleableResult =
  | { ok: true; mainText: string; styleText: string }
  | { ok: false; reason: string };

/** Sensible default palette values for tokens the doc doesn't already define. */
const TOKEN_DEFAULTS: Record<string, string> = {
  accent: 'rgb("#f0510e")',
  ink: 'rgb("#211c17")',
  "ink-soft": 'rgb("#6a6155")',
  rule: 'rgb("#d8cdb8")',
};

/**
 * A leading styling directive is one of:
 *   - `#set …`  (any set rule; e.g. page/text/par/heading/math.equation)
 *   - `#show <selector>: …`  (a show-RULE — note the selector before `:`; NOT
 *     a `#show: entry(…)` template application, which has nothing before `:`)
 *   - `#let <name> = <value>`  (a top-level binding; treated as a style token)
 * Determined from the directive's FIRST line; the directive may span multiple
 * lines (balanced parens/brackets/braces), handled by {@link scanDirective}.
 */
function classifyLead(line: string): "set" | "show" | "let" | null {
  const t = line.trimStart();
  if (t.startsWith("#set ") || t.startsWith("#set(")) return "set";
  if (/^#show\s+[^:]/.test(t)) return "show"; // has a selector before ':'
  if (/^#let\s+[\w-]+\s*=/.test(t)) return "let";
  return null;
}

/**
 * Starting at line index `i`, consume a (possibly multi-line) directive whose
 * extent is defined by balanced `()[]{}`. Returns the index of the line AFTER
 * the directive. We only balance delimiters; we do not parse Typst semantics.
 */
function scanDirective(lines: string[], i: number): number {
  let depth = 0;
  let j = i;
  for (; j < lines.length; j++) {
    for (const ch of lines[j] ?? "") {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) return j + 1; // directive closed on this line
  }
  return j; // unbalanced to EOF — caller treats as the whole remainder
}

/** A `#let <name> = <value>` token binding parsed from a lifted line block. */
function parseLetToken(block: string): { name: string; value: string } | null {
  const m = /^#let\s+([\w-]+)\s*=\s*([\s\S]+)$/.exec(block.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { name: m[1], value: m[2].trim() };
}

/**
 * Convert a markup-mode directive to its code-mode form for the doc() body:
 * drop the leading `#` from the FIRST line that begins with `#set`/`#show`. The
 * rest of a multi-line directive (and any leading comment lines) is untouched.
 */
function stripDirectiveHash(block: string): string {
  const lines = block.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k] ?? "";
    if (/^\s*#(set|show)\b/.test(l)) {
      lines[k] = l.replace(/^(\s*)#/, "$1");
      break; // only the directive head carries the markup `#`
    }
  }
  return lines.join("\n");
}

/**
 * Lift a non-conforming inline-styled document into the canonical style ABI.
 * PURE. See module docs for scope + failure modes.
 */
export function makeStyleable(input: MakeStyleableInput): MakeStyleableResult {
  const { mainText } = input;

  // Already conforming (imports /style.typ + applies an entry): nothing to do.
  // detectStyleability returns clean/shimmed only when a /style.typ import is
  // present; non-conforming/incompatible mean it's a candidate to lift.
  const before = detectStyleability(mainText);
  if (before.state === "clean" || before.state === "shimmed") {
    return { ok: false, reason: "This document is already styleable — it imports and applies a /style.typ module." };
  }
  if (mainText.includes('#import "/style.typ"')) {
    // Imports the style module but in a shape we won't rewrite (e.g. wildcard).
    return {
      ok: false,
      reason: "This document already imports /style.typ; converting that shape isn't supported here.",
    };
  }

  const lines = mainText.split("\n");

  // Walk the leading region, collecting contiguous styling directives. Blank
  // lines and full-line comments BETWEEN directives are kept with the block
  // (they're part of the styling preamble); the first non-styling content line
  // ends the block.
  type Lifted = { kind: "set" | "show" | "let"; text: string };
  const lifted: Lifted[] = [];
  const carriedComments: string[] = []; // comments/blanks pending before a directive
  let bodyStart = 0;
  let i = 0;
  let sawDirective = false;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("//")) {
      // Blank/comment: tentatively carry it; if a directive follows it belongs
      // to the block, otherwise the block ends before it.
      carriedComments.push(line);
      i++;
      continue;
    }

    const kind = classifyLead(line);
    if (kind === null) {
      // First real content line — the block ends here. The carried comments/
      // blanks belong to the BODY (they precede content, not styling).
      bodyStart = i - carriedComments.length;
      break;
    }

    // A styling directive. Flush any carried comments into the lifted block,
    // then consume the (possibly multi-line) directive.
    for (const c of carriedComments) lifted.push({ kind, text: c });
    carriedComments.length = 0;
    const end = scanDirective(lines, i);
    lifted.push({ kind, text: lines.slice(i, end).join("\n") });
    sawDirective = true;
    i = end;
    bodyStart = end;
  }
  if (i >= lines.length && sawDirective) bodyStart = lines.length;

  if (!sawDirective) {
    return {
      ok: false,
      reason: "This document has no leading block of styling directives to lift, so there's nothing to make styleable.",
    };
  }

  // Separate the lifted directives by kind. Only `#set`, `#show <selector>:`,
  // and CANONICAL-token `#let`s (accent/ink/ink-soft/rule) get lifted:
  //   - canonical `#let`s become the style's palette (overriding defaults), AND
  //     are re-imported into main (see buildMainText) so a body that references
  //     them stays bound;
  //   - #set/#show move into doc()'s body.
  // A NON-canonical top-level `#let` (e.g. a secondary helper color the body
  // uses) is NOT lifted — moved out it would be unbound in main, and inventing a
  // capability for it is out of scope — so it stays in main, ahead of the body
  // content, exactly where main can still see it.
  const tokenValues: Record<string, string> = {};
  const bodyDirectives: string[] = [];
  const keptLets: string[] = []; // non-canonical #let bindings to leave in main
  for (const item of lifted) {
    if (item.kind === "let") {
      const tok = parseLetToken(item.text);
      if (tok && CANONICAL_TOKENS.includes(tok.name)) {
        tokenValues[tok.name] = tok.value;
        continue; // a canonical token: hoist to the palette, not the body
      }
      if (tok) {
        keptLets.push(item.text); // a non-canonical #let: keep it in main
        continue;
      }
      // A carried comment that was tagged "let": send it with the style body.
      bodyDirectives.push(item.text);
      continue;
    }
    bodyDirectives.push(item.text);
  }

  // The remaining body content (everything from bodyStart onward), with the
  // lifted preamble removed and surrounding blank lines trimmed. Any kept
  // non-canonical #let bindings are prepended so the body's references resolve.
  const rawBody = lines.slice(bodyStart).join("\n").replace(/^\n+/, "");
  const body = keptLets.length > 0 ? `${keptLets.join("\n")}\n\n${rawBody}` : rawBody;

  const styleText = buildStyleText(tokenValues, bodyDirectives);
  const newMain = buildMainText(mainText, body);

  // Verify our own output meets the contract we target.
  const after = detectStyleability(newMain);
  if (after.state !== "clean" && after.state !== "shimmed") {
    return {
      ok: false,
      reason: `Transform produced a non-conforming /main.typ (state: ${after.state}). This document is outside the supported shape.`,
    };
  }

  return { ok: true, mainText: newMain, styleText };
}

/** Build the `/style.typ`: palette tokens + a `doc(…)` carrying the directives. */
function buildStyleText(tokenValues: Record<string, string>, bodyDirectives: string[]): string {
  const palette = CANONICAL_TOKENS.map(
    (tok) => `#let ${tok} = ${tokenValues[tok] ?? TOKEN_DEFAULTS[tok]}`,
  ).join("\n");

  // Move the lifted directives into doc()'s body, which is CODE mode: a markup-
  // mode `#set …` / `#show …` becomes bare `set …` / `show …` (the leading `#`
  // is only valid in markup; inside `{ … }` it's a syntax error). Strip the `#`
  // from the directive head on the FIRST non-comment line of each directive, then
  // indent one level. Comment lines are left verbatim.
  const indented = bodyDirectives
    .map((d) => stripDirectiveHash(d))
    .map((d) => d.split("\n").map((l) => (l.length > 0 ? `  ${l}` : l)).join("\n"))
    .join("\n\n");

  return [
    "// Generated by Galley's make-styleable transform: the appearance lifted",
    "// out of /main.typ into the canonical style ABI (doc + palette tokens) so",
    "// the Style Library can swap it in place.",
    "",
    palette,
    "",
    "#let doc(",
    "  title: none,",
    "  author: none,",
    "  date: none,",
    "  abstract: none,",
    "  body,",
    "  ..extra,",
    ") = {",
    indented,
    "",
    "  body",
    "}",
    "",
  ].join("\n");
}

/** Build the rewritten `/main.typ`: import (entry + palette) + show + body. */
function buildMainText(originalMain: string, body: string): string {
  // Import the entry AND all four palette tokens: a lifted body frequently still
  // references a token it used to define inline (e.g. a cover `#text(fill:
  // accent)…`). Importing the palette keeps those references bound; Typst does
  // NOT error on an unused import, so importing all four is safe even when the
  // body uses none. detectStyleability stays `clean` — entry + canonical tokens
  // are exactly the allowed import set.
  void originalMain;
  const importList = ["doc", ...CANONICAL_TOKENS].join(", ");
  return [`#import "/style.typ": ${importList}`, "", "#show: doc.with()", "", body].join("\n");
}
