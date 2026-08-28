# Accessibility (a11y) notes

The current accessibility state of the Galley web UI, focused on what actually
breaks keyboard and screen-reader users: keyboard operability, focus
management, accessible names/roles, a skip link, and a visible focus indicator.

## Scope

- Shell: `ProjectApp.tsx` (the project shell — the only shell; the legacy
  single-file `App.tsx` and its `?single=1` hatch were removed).
- Chrome: `IconRail`, `DockedPanel`, the topbar pills, the file tree, the
  command surfaces (`CommandPalette`, `CommandSheet`).
- Modals/dialogs: `InstructionsPanel`, `ReviseSelectionPrompt`,
  `InsertReferencePicker`, `AgentOpenConsent`, `TemplatePicker`, and the inline
  version-compare / git-fetch overlay in `ProjectApp`.

## What the UI provides

- **Dialog semantics.** Every modal has `role="dialog"` + `aria-modal="true"`
  + an accessible name (`aria-labelledby` / `aria-label`), moves focus to a
  sensible first target on open, and closes on **Escape** and a backdrop click.
- **Focus trap + focus restore in every modal**, via a small reusable hook
  (`apps/web/src/components/use-focus-trap.ts`). `useFocusTrap(containerRef,
  open)` binds a capture-phase `keydown` while open: on Tab at the last
  focusable (or Shift-Tab at the first, or focus escaped outside) it wraps
  focus back inside the dialog; on close/unmount it restores focus to whatever
  was focused when the dialog opened (the trigger), unless the user has since
  moved focus elsewhere. The decision core, `nextTrapFocus(focusables, active,
  shift)`, is a pure, unit-tested function.
- **Skip-to-content link** (`data-testid="skip-link"`, visually hidden until
  focused) at the top of the shell; it focuses the editor.
- **Landmarks.** The main content region carries `role="main"` +
  `aria-label="Editor and preview"`; the icon rail is a
  `<nav aria-label="Workspace panels">`; the agent sidebar is an
  `<aside aria-label="AI agent">`; the preview is a `role="region"`.
- **Visible focus.** A global, token-based `:focus-visible` ring in both
  themes, with a `prefers-reduced-motion` guard.
- **Icon rail**: per-button `aria-label` + `aria-pressed` + `title`, glyphs
  `aria-hidden`.
- **File tree**: folder rows carry `aria-expanded`; the active file row carries
  `aria-current`; icon-only operations (rename/delete/star/main/add) have
  `title`s.
- **Command palette**: keyboard-first and ARIA-wired — `role="combobox"` input
  → `role="listbox"` → `role="option"`, with `aria-activedescendant`,
  `aria-selected`, and ↑/↓ + Enter + Escape.

## Testing

`axe-core` is not a project dependency (the unit gate runs in node without
jsdom, so it isn't trivially addable). Accessibility behavior is asserted with
real keyboard-driven Playwright e2e instead:

- `apps/web/src/components/use-focus-trap.test.ts` — pure unit tests for
  `nextTrapFocus` (wrap-around, middle no-op, escaped-focus recapture, empty +
  single-element edge cases) and the `FOCUSABLE_SELECTOR` shape.
- `apps/web/e2e/a11y.spec.ts` — keyboard-only flows: skip link reaches +
  focuses the editor; landmarks present; ⌘K palette focus-in / arrow-nav /
  Escape-restores-to-trigger; shortcuts sheet focus-in / Escape-restore;
  template picker Tab/Shift-Tab focus trap + Escape-restore.

## Known gaps

- **No automated `axe-core` audit.** It would catch contrast/structure
  regressions cheaply, but needs a browser harness; the natural home is a
  dedicated `@axe-core/playwright` check. The keyboard e2e above covers the
  operability essentials.
- **The file tree is not a full ARIA tree.** Rows are operable (buttons with
  names, folders with `aria-expanded`, `aria-current` on the active file), but
  the `<ul>`/`<li>` structure does not implement `role="tree"`/`treeitem` with
  roving tabindex and arrow-key traversal.
- **No roving tabindex on radio groups.** `TemplatePicker` uses
  `role="radiogroup"`/`radio` (correct), but arrow-key movement between radios
  isn't wired; each radio is Tab-reachable, which is operable if not ideal.
- **Live regions are partial.** Some transient status surfaces use
  `role="status"`, but there has been no systematic `aria-live` audit of every
  async surface (compile state, save state).
