# ADR-0030: Background artwork independent of colour

Accepted 2026-10-26.

Appearance offers Plain and Artwork with visual previews. Artwork is the default
for an unset or invalid `galley.backgroundStyle` local preference; an explicit
Plain choice persists independently of the Studio/Press skin and light/dark mode.

Static textured paper strata use the Studio or Press treatment in library, settings and sign-in
chrome. The editor has only a small top-chrome accent. Document SVG, editor
surfaces and exported content never receive background art. Copy, controls and
cards retain opaque surfaces where needed for their existing contrast guarantees.
Loading screens reflect actual route/session readiness without artificial delays.

The canonical raster is `apps/web/public/paper-strata.webp`; the hosted landing
ships a byte-identical export, its existing gold palette and the same preference
key. Its fixed same-origin asset route requires only `img-src 'self'`; the
remaining CSP and authentication behavior are unchanged. Preferences apply within
each browser origin.

The library uses a primary template action, import and inline search above compact
cover cards. Covers use real project names with decorative page rules; edit labels
use stored timestamps. No page counts or document renderings are invented or
compiled in the background. The card opens its project by pointer or keyboard;
rename, tags, archive and confirmed deletion live in the project action disclosure.
