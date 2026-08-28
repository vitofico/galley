/**
 * "Protein Measurement with the Folin Phenol Reagent" — the Lowry 1951 demo
 * workspace, a second styleable seed alongside the Einstein desk (#20). It
 * reconstructs the most-cited paper in the scientific literature (Lowry,
 * Rosebrough, Farr & Randall, J. Biol. Chem. 193 (1951) 265) as a single
 * journal article, dressed by a bespoke conforming `/style.typ` so it boots in
 * the house format of the journal that published it (masthead, full-width title
 * and abstract, justified two-column body) AND can be restyled in place by the
 * Style Library.
 *
 * Reached via the `?seed=lowry` boot hatch and `lowrySeed()` — it is a SEED, not
 * a template (it is deliberately absent from `templates/index.ts`).
 *
 * `.typ` sources ship as raw strings via Vite's `?raw` suffix (typed by the
 * ambient `*.typ?raw` declaration in `vite-env.d.ts`). The `.bib` source is an
 * inline constant — `*.bib?raw` has no ambient type declaration.
 *
 * Constraints (mirroring the Einstein demo): pure built-in Typst — no `@preview`
 * packages (the browser resolver is fail-closed) — real math mode (NewCMMath is
 * bundled), and the tree compiles with zero diagnostics; see
 * `demo/lowry-1951.compile.test.ts`, the authoritative gate, and
 * `demo/lowry-styleability.test.ts`, the clean-ABI guard.
 */
import type { SeedFile } from "@galley/collab";

import liveStyle from "./lowry-1951/style.typ?raw";
import mainLive from "./lowry-1951/main.typ?raw";
import introductionLive from "./lowry-1951/introduction.typ?raw";
import reagentsLive from "./lowry-1951/reagents.typ?raw";
import procedureLive from "./lowry-1951/procedure.typ?raw";
import resultsLive from "./lowry-1951/results.typ?raw";

/**
 * The bibliography — real mid-century references, every key actually cited via
 * `@key` in the paper. Inline (not `?raw`): see the module docs.
 */
const REFS_BIB = `@article{folin1927,
  author  = {Folin, Otto and Ciocalteu, Vintila},
  title   = {On tyrosine and tryptophane determinations in proteins},
  journal = {Journal of Biological Chemistry},
  volume  = {73},
  number  = {2},
  pages   = {627--650},
  year    = {1927},
}

@article{wu1922,
  author  = {Wu, Hsien},
  title   = {A new colorimetric method for the determination of plasma proteins},
  journal = {Journal of Biological Chemistry},
  volume  = {51},
  number  = {1},
  pages   = {33--39},
  year    = {1922},
}

@article{herriott1941,
  author  = {Herriott, Roger M.},
  title   = {Reaction of Folin's reagent with proteins and biuret compounds in presence of cupric ion},
  journal = {Proceedings of the Society for Experimental Biology and Medicine},
  volume  = {46},
  number  = {4},
  pages   = {642--644},
  year    = {1941},
}
`;

/** The entry file of the Lowry demo workspace. */
export const LOWRY_MAIN = "/main.typ";

/** The display name for the Lowry demo (the `?seed=lowry` seed). */
export const LOWRY_NAME = "Protein Measurement — Lowry 1951";

/**
 * The seed tree — `/main.typ` first, then the swappable `/style.typ`, then the
 * `#include`d body sections and the bibliography. Same `{ path, text }` shape as
 * `DEMO_FILES`, ready for `seedIfPristine(LOWRY_FILES, LOWRY_MAIN, author)`.
 */
export const LOWRY_FILES: SeedFile[] = [
  { path: "/main.typ", text: mainLive },
  { path: "/style.typ", text: liveStyle },
  { path: "/introduction.typ", text: introductionLive },
  { path: "/reagents.typ", text: reagentsLive },
  { path: "/procedure.typ", text: procedureLive },
  { path: "/results.typ", text: resultsLive },
  { path: "/refs.bib", text: REFS_BIB },
];
