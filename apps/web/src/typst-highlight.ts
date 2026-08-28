/**
 * A pragmatic Typst syntax highlighter implemented as a CodeMirror 6
 * `StreamLanguage`. It is not a full grammar (a `tinymist`/Lezer grammar is
 * post-MVP, on the roadmap) but it covers the common Typst surface so the
 * editor reads as Typst:
 *
 *   - headings (`=`, `==`, …) and list markers (`-`, `+`, `1.`)
 *   - strong `*…*` / emphasis `_…_`
 *   - inline `$ … $` AND multiline block `$ … $` math (state across lines)
 *   - inline raw `` `…` `` AND fenced ```` ```lang … ``` ```` raw (across lines)
 *   - code mode after `#`: keywords (`let`/`set`/`show`/`if`/`else`/`for`/…),
 *     function-call names, `#( … )` / `#{ … }` code expressions, strings
 *   - escapes (`\$`, `\#`, `\\`, …) — an escaped delimiter does NOT open
 *     math/code
 *   - labels `<name>` and references `@name`
 *   - line and block comments
 *
 * Token names are mapped to `@lezer/highlight` tags via `tokenTable` so the
 * editor's `HighlightStyle` (CodeMirror's default style, from `basicSetup`)
 * colours them.
 */
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  type StringStream,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** Typst code-mode keywords (the bare word after `#`, or inside code blocks). */
const KEYWORDS = new Set([
  "let",
  "set",
  "show",
  "if",
  "else",
  "for",
  "while",
  "import",
  "include",
  "return",
  "break",
  "continue",
  "in",
  "as",
  "and",
  "or",
  "not",
  "none",
  "auto",
  "true",
  "false",
  "context",
]);

interface State {
  /** Inside a block comment. */
  inBlockComment: boolean;
  /** Inside a multiline `$ … $` block-math region. */
  inBlockMath: boolean;
  /** The fence string (e.g. "```") if inside a fenced raw block, else null. */
  rawFence: string | null;
  /**
   * Brace/paren nesting depth of an active `#{ … }` / `#( … )` code region.
   * Zero means we are in markup mode.
   */
  codeDepth: number;
}

/** Consume one code-mode token (used inside `#{ … }` / `#( … )` and after `#`). */
function codeToken(stream: StringStream, state: State): string | null {
  // Comments take priority even in code mode.
  if (stream.match("/*")) {
    state.inBlockComment = true;
    return "comment";
  }
  if (stream.match(/\/\/.*/)) return "comment";

  // String literal.
  if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";

  // Numbers (with optional unit / fraction suffix).
  if (stream.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:pt|mm|cm|in|em|fr|deg|%)?/))
    return "number";

  // Identifiers: keyword, else a function call if followed by `(`, else a name.
  const id = stream.match(/[\p{L}_][\p{L}\p{N}_-]*/u) as RegExpMatchArray | null;
  if (id) {
    const word = id[0];
    if (KEYWORDS.has(word)) return "keyword";
    if (stream.peek() === "(") return "function";
    return "variableName";
  }

  // Track brace/paren nesting so we know when the code region ends.
  const ch = stream.peek();
  if (ch === "{" || ch === "(") {
    state.codeDepth++;
    stream.next();
    return null;
  }
  if (ch === "}" || ch === ")") {
    stream.next();
    if (state.codeDepth > 0) state.codeDepth--;
    return null;
  }

  stream.next();
  return null;
}

export const typstLanguage = StreamLanguage.define<State>({
  startState: () => ({
    inBlockComment: false,
    inBlockMath: false,
    rawFence: null,
    codeDepth: 0,
  }),
  token(stream, state) {
    // ---- Multiline states first (they win over everything on the line). ----

    if (state.inBlockComment) {
      if (stream.match(/.*?\*\//)) state.inBlockComment = false;
      else stream.skipToEnd();
      return "comment";
    }

    if (state.rawFence) {
      // A line consisting solely of the fence closes the block.
      if (stream.sol() && stream.match(new RegExp("\\s*" + state.rawFence + "\\s*$"))) {
        state.rawFence = null;
        return "raw";
      }
      stream.skipToEnd();
      return "raw";
    }

    if (state.inBlockMath) {
      // A `$` (not escaped) closes the block.
      if (stream.match(/\\./)) return "escape";
      if (stream.eat("$")) {
        state.inBlockMath = false;
        return "math";
      }
      // Consume up to the next `$` or backslash, staying in math.
      if (stream.match(/[^$\\]+/)) return "math";
      stream.next();
      return "math";
    }

    // ---- Active inline code region: `#{ … }` / `#( … )`. ----
    if (state.codeDepth > 0) {
      return codeToken(stream, state);
    }

    // ---- Comments. ----
    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }
    if (stream.match(/\/\/.*/)) return "comment";

    // ---- Escapes: `\$`, `\#`, `\\`, etc. (must precede `$`/`#`/raw). ----
    if (stream.match(/\\[^\s]/) || stream.match(/\\$/)) return "escape";

    // ---- Fenced raw block: ```lang … (opens a multiline region). ----
    if (stream.sol()) {
      const fence = stream.match(/`{3,}/, false) as RegExpMatchArray | null;
      if (fence) {
        const ticks = fence[0];
        stream.match(ticks); // consume the backticks
        stream.skipToEnd(); // consume optional language tag + rest
        state.rawFence = ticks;
        return "raw";
      }
    }

    // ---- Inline raw: `code` (single line). ----
    if (stream.peek() === "`") {
      stream.next();
      stream.match(/[^`]*/);
      stream.eat("`");
      return "raw";
    }

    // ---- Headings: `=`+ at line start followed by space. ----
    if (stream.sol() && stream.match(/=+\s/)) {
      stream.skipToEnd();
      return "heading";
    }

    // ---- List markers at line start: `-`, `+`, `N.`. ----
    if (stream.sol() && stream.match(/\s*(?:[-+]|\d+\.)\s/)) {
      return "list";
    }

    // ---- Labels `<name>` and references `@name`. ----
    if (stream.match(/<[\p{L}_][\p{L}\p{N}_:.-]*>/u)) return "labelName";
    if (stream.match(/@[\p{L}_][\p{L}\p{N}_:.-]*/u)) return "labelName";

    // ---- Math. ----
    if (stream.peek() === "$") {
      stream.next();
      // Block math: `$` followed by end-of-line (opening of a multiline region)
      // or `$ ` (a leading space is the Typst convention for display math).
      if (stream.eol()) {
        state.inBlockMath = true;
        return "math";
      }
      // Inline math: consume to the matching `$` on this line.
      stream.match(/(?:\\.|[^$\\])*/);
      if (!stream.eat("$")) {
        // Unterminated on this line → treat as block math opener.
        state.inBlockMath = true;
      }
      return "math";
    }

    // ---- Strong `*…*` and emphasis `_…_` (single line). ----
    if (stream.match(/\*[^*\n]+\*/)) return "strong";
    if (stream.match(/_[^_\n]+_/)) return "emphasis";

    // ---- Code mode after `#`. ----
    if (stream.peek() === "#") {
      stream.next();
      // `#{ … }` / `#( … )` code expression — enter a tracked code region.
      const opener = stream.peek();
      if (opener === "{" || opener === "(") {
        state.codeDepth++;
        stream.next();
        return null;
      }
      // `#ident`: keyword, function call, or a plain reference.
      const id = stream.match(/[\p{L}_][\p{L}\p{N}_-]*/u) as
        | RegExpMatchArray
        | null;
      if (id) {
        const word = id[0];
        if (KEYWORDS.has(word)) return "keyword";
        if (stream.peek() === "(") return "function";
        return "variableName";
      }
      return null;
    }

    // ---- String literal in markup (rare, but cheap to support). ----
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";

    stream.next();
    return null;
  },
  tokenTable: {
    heading: tags.heading,
    list: tags.list,
    math: tags.special(tags.string),
    raw: tags.monospace,
    strong: tags.strong,
    emphasis: tags.emphasis,
    keyword: tags.keyword,
    function: tags.function(tags.variableName),
    variableName: tags.variableName,
    number: tags.number,
    string: tags.string,
    comment: tags.comment,
    escape: tags.escape,
    labelName: tags.labelName,
  },
});

/**
 * A Typst highlight palette tuned to the "galley proof / typesetter's desk" design
 * tokens (see styles.css) so the editor reads as part of the warm-paper aesthetic
 * rather than CodeMirror's default blue/green. Non-fallback, so it wins over
 * basicSetup's `defaultHighlightStyle` (a fallback) for the tags below; any tag we
 * don't list still falls back to the default.
 *
 * THEME-REACTIVE (R6): every token colour is a CSS custom property (`--syn-*`),
 * NOT a hardcoded hex. The LIGHT values live on `:root` in styles.css; the DARK
 * overrides live under `:root[data-theme="dark"]` in theme.css. Because the
 * highlight style only emits `color: var(--syn-…)`, flipping `data-theme`
 * recolours the editor with no remount — and the dark values clear WCAG AA on
 * the dark ground (a hardcoded light palette did NOT, scoring ~2:1; see
 * typst-highlight.contrast.test.ts). `--syn-*-strong`/`-em` reuse `--ink` so
 * bold/italic body text follows the reading layer in either theme.
 */
const typstHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syn-heading)", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700", color: "var(--ink)" },
  { tag: tags.emphasis, fontStyle: "italic", color: "var(--ink)" },
  { tag: tags.keyword, color: "var(--syn-keyword)" },
  { tag: tags.function(tags.variableName), color: "var(--syn-function)" },
  { tag: tags.variableName, color: "var(--syn-variable)" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: tags.special(tags.string), color: "var(--syn-math)" }, // math
  { tag: tags.monospace, color: "var(--syn-raw)" }, // raw blocks
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: tags.escape, color: "var(--syn-escape)" },
  { tag: tags.labelName, color: "var(--syn-label)" }, // labels + refs
  { tag: tags.list, color: "var(--syn-list)" },
]);

/**
 * The DARK-theme values of the `--syn-*` tokens above, mirrored in TypeScript so
 * the contrast guard (typst-highlight.contrast.test.ts) can assert each clears
 * WCAG AA against the dark editor ground WITHOUT parsing CSS. These MUST stay in
 * lock-step with the `:root[data-theme="dark"]` block in theme.css. Tasteful,
 * distinct hues — amber heading, coral keyword/list, teal/cyan function & math,
 * soft-teal variables, sage strings, tan raw, gold numbers, lavender labels.
 */
export const DARK_SYNTAX_COLORS = {
  heading: "#e8a06a",
  keyword: "#ec8466",
  function: "#54c2ba",
  variable: "#8fc4be",
  string: "#a3c178",
  math: "#54c2ba",
  raw: "#cf9f6e",
  number: "#d99f5f",
  comment: "#9a9082",
  escape: "#57c0b6",
  label: "#b298dc",
  list: "#ec8466",
} as const;

/**
 * Agent Send button (R6 — finding 1). In dark theme the teal fill `--agent`
 * (#46b8b0) carried a WHITE label at only 2.40:1; the label now uses the
 * `--on-agent` ink token (warm near-black), which clears AA on that fill. These
 * mirror theme.css so the contrast guard can assert the pair.
 */
export const AGENT_FILL_DARK = "#46b8b0";
export const ON_AGENT_DARK = "#10211f";

/** Editor extension: the Typst-tuned highlight style. Add after `typstLanguage`. */
export const typstHighlightStyle = syntaxHighlighting(typstHighlight);
