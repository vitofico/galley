/**
 * Roadmap #13 — cross-reference autocomplete (CodeMirror 6).
 *
 * A COMPOSABLE completion source for Typst `@name` references. It is deliberately
 * NOT a full `autocompletion({ override: [...] })` extension: the coordinator
 * merges several sources, so this exports a bare `CompletionSource` that fires
 * after `@` and offers the known label names.
 *
 * INJECTION-ONLY: this module does NOT import the label core (`labels.ts`) or
 * `@galley/agent`. The barrel does not export the core yet, and source-of-truth
 * for label names belongs to the host. Names arrive via the `getLabels`
 * callback, read lazily on every invocation so the menu always reflects the
 * current document state.
 *
 * Any CSS would ship via `EditorView.baseTheme(...)` with `var(--token, fallback)`
 * design tokens — never `styles.css`. The completion menu here needs no custom
 * styling, so no theme is exported; the hook is documented for future use.
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";

/**
 * Match an `@` followed by zero-or-more label-name chars immediately before the
 * cursor. Mirrors the label charset (letters/digits/`-`/`_`/`.`/`:`).
 */
const REF_TOKEN = /@[\w\-.:]*/;

/**
 * Build a completion source that offers `getLabels()` after an `@` token.
 *
 * @param getLabels lazily supplies the current known label names (sorted/unique
 *   is the caller's choice; this source preserves the given order).
 */
export function labelCompletionSource(
  getLabels: () => string[],
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(REF_TOKEN);
    if (!token) return null;
    // `matchBefore` returns a match starting with `@`; require the `@` itself.
    if (token.text[0] !== "@") return null;

    const options: Completion[] = getLabels().map((name) => ({
      label: name,
      type: "constant",
      apply: name,
    }));

    return {
      // Replace from the `@` so CM filters against the typed prefix and the
      // applied name cleanly overwrites the partially-typed reference token.
      from: token.from + 1,
      to: context.pos,
      options,
      // Keep the menu open as the user types more name chars.
      validFor: /^[\w\-.:]*$/,
    };
  };
}
