/**
 * CodeMirror 6 find / find-replace, themed to the galley "proof on the desk"
 * design tokens (roadmap #11.5).
 *
 * ADDITIVE / INERT: this bundles `@codemirror/search`'s search panel, its
 * keymap, and selection-match highlighting. With no user action the editor is
 * visually unchanged — the panel only mounts when the user invokes it (Mod-f via
 * `searchKeymap`). So a coordinator can add this to the extensions array with no
 * effect on the at-rest editor (and existing e2e stay green).
 *
 * The panel is styled via `EditorView.baseTheme` using CSS custom properties
 * (`--paper`, `--ink`, `--rule`, `--accent`) defined in styles.css :root — no
 * hardcoded colours, and this file never touches styles.css.
 */
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
} from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Theme for the search panel, drawn from the design tokens so it reads as part
 * of the warm-paper aesthetic. Uses `baseTheme` (low precedence) so it can be
 * overridden by stylesheet rules and never fights the editor's own theme.
 */
const searchPanelTheme = EditorView.baseTheme({
  ".cm-panel.cm-search": {
    backgroundColor: "var(--paper)",
    color: "var(--ink)",
    borderTop: "1px solid var(--rule)",
    padding: "6px 8px",
    fontFamily: "inherit",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label":
    {
      fontFamily: "inherit",
      fontSize: "inherit",
      color: "var(--ink)",
    },
  ".cm-panel.cm-search input[type=text]": {
    backgroundColor: "var(--paper)",
    color: "var(--ink)",
    border: "1px solid var(--rule)",
    borderRadius: "3px",
    padding: "2px 6px",
  },
  ".cm-panel.cm-search input[type=text]:focus": {
    outline: "none",
    borderColor: "var(--accent)",
  },
  ".cm-panel.cm-search button": {
    backgroundColor: "var(--paper)",
    border: "1px solid var(--rule)",
    borderRadius: "3px",
    padding: "2px 8px",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button:hover": {
    borderColor: "var(--accent)",
    color: "var(--accent)",
  },
  ".cm-panel.cm-search .cm-button": {
    backgroundImage: "none",
  },
  // The little close [x] in the corner of the panel.
  ".cm-panel.cm-search [name=close]": {
    color: "var(--ink)",
  },
});

/**
 * Build the find/replace extension. Returns an `Extension` (array) ready to drop
 * into an `EditorView`'s extensions list.
 *
 *   - `search({ top: true })` mounts the panel at the top of the editor.
 *   - `keymap.of(searchKeymap)` binds Mod-f (open), Mod-Alt-f (replace), Enter
 *     (next), etc.
 *   - `highlightSelectionMatches()` underlines other occurrences of the
 *     selection.
 *   - the theme above paints the panel with design tokens.
 */
export function searchPanelExtension(): Extension {
  return [
    search({ top: true }),
    keymap.of(searchKeymap),
    highlightSelectionMatches(),
    searchPanelTheme,
  ];
}
