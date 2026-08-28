/**
 * Cite-key autocompletion source (roadmap #6) — a COMPOSABLE CodeMirror 6
 * completion source, NOT a full autocompletion extension. A host composes it into
 * its own `autocompletion({ override: [...] })` config (or adds it via a language
 * data facet); this file deliberately wires nothing on its own, so it is inert
 * until the coordinator plugs it in.
 *
 * INJECTION-ONLY: this module does NOT import `citation.ts` or `@galley/agent`.
 * Known cite keys arrive through the `getKeys` callback the host supplies, so the
 * completion layer has zero coupling to where/how citations are stored or parsed.
 *
 * Trigger: after an `@` (Typst's cite sigil), e.g. `@smith2020`. We match the `@`
 * plus any cite-key characters before the cursor and offer matching known keys.
 *
 * All CSS ships via `EditorView.baseTheme(...)` with token vars + fallbacks, so
 * this never touches `styles.css`.
 */
import { EditorView } from "@codemirror/view";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";

// `@` followed by zero-or-more cite-key chars. Typst cite labels allow letters,
// digits, `-`, `_`, `.`, `:`. The `@` itself is included so we can replace from it.
const CITE_BEFORE_RE = /@[\w\-.:]*/;

/**
 * Build a composable completion source that offers known cite keys after `@`.
 *
 * @param getKeys returns the CURRENT set of known cite keys (called per request,
 *   so the host can keep it live). Injection-only: no import of citation logic.
 */
export function citeCompletionSource(getKeys: () => string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(CITE_BEFORE_RE);
    if (!match) return null;
    // Don't pop open on a bare `@` unless the user explicitly invoked completion
    // (avoids fighting the user the instant they type `@`). With an explicit
    // request (Ctrl-Space) we still offer everything.
    if (match.from === match.to) return null;
    if (match.text === "@" && !context.explicit) return null;

    // The typed prefix AFTER the `@`, lowercased for case-insensitive matching.
    const typed = match.text.slice(1).toLowerCase();

    const keys = getKeys();
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const key of keys) {
      if (typeof key !== "string" || key.length === 0) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      if (typed.length > 0 && !key.toLowerCase().includes(typed)) continue;
      options.push({
        label: `@${key}`,
        // Replace the matched span (including the `@`) with the full `@key`.
        apply: `@${key}`,
        type: "variable",
        detail: "cite",
        boost: key.toLowerCase().startsWith(typed) ? 1 : 0,
      });
    }
    if (options.length === 0) return null;

    return {
      from: match.from,
      to: match.to,
      options,
      // Keep the list open + filtered while the user keeps typing cite chars.
      validFor: /^@[\w\-.:]*$/,
    };
  };
}

/**
 * Optional theme for the cite completion tokens. Composable: a host may add this
 * extension alongside the source. Uses token vars with fallbacks; never edits
 * `styles.css`.
 */
export const citeCompletionTheme = EditorView.baseTheme({
  ".cm-completionLabel": {
    fontFamily: "var(--cite-font, var(--mono-font, ui-monospace, monospace))",
  },
  ".cm-completionDetail": {
    color: "var(--cite-detail, var(--muted, #6b7280))",
    fontStyle: "normal",
    marginLeft: "0.5em",
  },
});
