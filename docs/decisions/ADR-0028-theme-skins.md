# ADR-0028 — Two-skin theming model (Studio default + Press alternate)

- **Status:** Accepted (2026-06-19); amended (2026-06-21) to make **Studio** the
  default skin — the bare `:root` is now Studio-light, the palette of the Galley
  logo (`#f0510e`), so the un-skinned app (including the boot-time sign-in screen)
  already wears the brand. Press becomes the opt-in alternate.
- **Context:** the visual-rebrand work established a tangerine identity (Studio)
  but Galley's hosted product (galley-cloud) has a distinct gold/parchment identity
  (Press). ADR-0028 records the model that ships both as first-class palettes.

## Context

Galley has always had a light/dark mode switch (`data-theme`). The rebrand introduced
a second identity — warm gold-and-parchment (Press) — alongside the original tangerine
(Studio). Rather than picking one, the decision is to ship both as *skins*, keeping the
mechanism consistent with the existing mode axis. The design mockup `style-preview.html`
was the visual origin.

The Galley logo (`mark.svg` / `favicon.svg`) is a tangerine (`#f0510e`) tile — the
Studio accent. Shipping Press as the `:root` default meant the un-skinned surfaces
the router never owns (notably the boot-time sign-in card in `AuthGate`, which
`main.tsx` renders before any route shell applies a skin) painted gold, clashing
with the tangerine logo beside them. The 2026-06-21 amendment flips the default so
the bare stylesheet matches the logo with no JS and no FOUC.

## Decision

### Two orthogonal axes on `<html>`

| Attribute    | Values                          | Meaning          | Default              |
|--------------|---------------------------------|------------------|----------------------|
| `data-skin`  | absent (= `studio`) \| `"press"`| palette identity | absent → **studio**  |
| `data-theme` | absent (= light) \| `"dark"`    | light/dark mode  | absent → **light**   |

**Absence = default for both.** The bare `:root` block IS the Studio-light palette.
No `data-skin` means Studio; no `data-theme` means light. This mirrors the existing
mode contract exactly and guarantees the pre-hydration paint already shows the correct
default — no FOUC on the happy path, and the un-skinned sign-in screen wears the logo's
tangerine without any JS having run.

The four resulting selector blocks:

| Combination   | Selector                                      | File         |
|---------------|-----------------------------------------------|--------------|
| Studio · light| `:root`                                       | `styles.css` |
| Studio · dark | `:root[data-theme="dark"]`                    | `theme.css`  |
| Press · light | `:root[data-skin="press"]`                    | `theme.css`  |
| Press · dark  | `:root[data-skin="press"][data-theme="dark"]` | `theme.css`  |

The shared dark lifts (`--syn-*`, `--agent*`, `--ok/--warn/--err`) live in the
default-dark `:root[data-theme="dark"]` block and are inherited by BOTH dark skins
(a skin swap must never alter code readability or agent/status semantics).

### Studio is the default — the face of Galley

Studio (tangerine on white) is the `:root` default — it is the Galley logo's palette,
so the un-skinned app already reads as Galley. Press (warm parchment, gold CTA, deep
bronze emphasis) is the opt-in alternate skin, selectable in Settings and persisted via
`galley.skin` in `localStorage`. The `index.html` `<meta name="theme-color">` and the
pre-paint background are set to the Studio grounds (`#ffffff` light / `#101113` dark).

### Skin-varying tokens (22)

The following 22 tokens resolve to different values per skin; all other tokens are shared:

```
color-scheme
--paper  --paper-raised  --paper-sunk  --paper-hi  --preview-gutter
--ink    --ink-soft  --ink-faint
--line   --line-strong
--brand
--accent  --accent-deep  --accent-soft  --on-accent
--shadow-1  --shadow-2  --shadow-doc
--chrome  --chrome-opaque  --chrome-border
```

### What stays shared (cross-skin constants)

- **`--doc-paper: #fdfcf9`** — the rendered document sheet is invariant across all
  four palettes. A skin swap must never alter the document's visual page.
- **`--agent*` (teal family)** — the agent accent is semantic ("peer, not brand").
  It stays in the same teal family (`#0c6a63` light / `#46b8b0` dark) in both skins
  so the meaning survives a skin swap.
- **`--syn-*`** — syntax-highlight colors stay constant; swapping a skin must not
  alter code readability.
- **Status colors (`--ok`, `--warn`, `--err`)** — token names and semantic mapping
  (green=ok, amber=warn, red=err) are invariant across skins; only per-mode
  (light/dark) lightness differs. They are NOT skin-varying.
- Radii, font stacks, spacing, and all structural tokens are shared.

### Guards

1. **Four-palette AA contrast matrix** (`theme.test.ts`) — every foreground/background
   pair across all four token sets must pass WCAG AA (or a documented brand exception).
   Explicit pins cover: `--accent-deep` on `--paper`/`--paper-raised`, `--ink-soft`
   on `--paper`, `--on-accent` on `--accent`, and status colors on their surfaces.
   `--doc-paper` must be identical across all four (asserted).
2. **Brand-literal discipline** (`skin-discipline.test.ts`) — a static guard asserts
   that no brand-fill hex literal from EITHER skin remains in component CSS, so a
   hardcoded color cannot survive a skin swap in either direction: Studio
   (`#f0510e`, `#ad4b00`, `#ff6a3d`, `#ff9170`, `#fdeae0`) and Press (`#e8b04b`,
   `#c9912f`, `#8a5a12`, `#f6ead0`). A future leak fails CI.

## Consequences

- `styles.css` `:root` is the Studio-light palette; Press's values live in
  `[data-skin="press"]` blocks in `theme.css` — the four palettes keep identical
  values regardless of which is the `:root` default, only the selector context moves.
- Skin choice is persisted and applied before first paint (mirrors existing mode
  bootstrap), so there is no FOUC on returning visits either.
- The constraint of ≤ 2 skins is deliberate: each additional skin multiplies the
  contrast-matrix surface (4 pairs per token per skin). Three skins = 12 pairs.

## Non-goals

- User-authored or custom themes.
- More than two skins at launch.
- Per-document or per-project skins.
- A theme marketplace or skin import/export.

## Alternatives considered

- **One skin only (pick Press, drop Studio)** — rejected. Studio is the current
  production identity; dropping it immediately is a regression for users familiar
  with the tangerine palette, and the mechanism to support two skins costs very
  little once the two-axis model is in place.
- **CSS class instead of `data-skin` attribute** — rejected. `data-skin` is
  consistent with `data-theme` and is a semantically meaningful attribute, not a
  presentational class.
- **JS-only theming (no CSS custom properties)** — rejected. The existing
  `var(--…)` cascade is already in place; inline JS switching would be slower and
  require touching every component.
