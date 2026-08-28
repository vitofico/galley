/**
 * "Annus Mirabilis" — the Einstein demo workspace content module (roadmap
 * #20.1). Einstein's desk at the Bern patent office, 1905: the live eight-file
 * tree (`DEMO_FILES` + `DEMO_MAIN`) and the four pre-dated history drafts
 * (`DEMO_HISTORY`) that tell the story of the year — ending with E = mc²
 * appearing in Version Compare.
 *
 * PURELY ADDITIVE in this slice: nothing imports this module yet. The seed
 * flip (#20.2: `project-session.ts` re-points at `DEMO_FILES` and seeds
 * `DEMO_HISTORY` via the version store) and the template encore (#20.3) land
 * in later waves.
 *
 * `.typ` sources ship as raw strings via Vite's `?raw` suffix (typed by the
 * ambient `*.typ?raw` declaration in `vite-env.d.ts`, resolved by Vitest's
 * vite pipeline in the unit gate). The `.bib` source is an inline constant —
 * `*.bib?raw` has no ambient type declaration, and this slice edits no
 * existing file.
 *
 * Constraints (spec §3): pure built-in Typst — no `@preview` packages (the
 * browser resolver is fail-closed) — real math mode (NewCMMath is bundled),
 * and every tree (live + each draft) compiles with zero diagnostics; see
 * `einstein-1905.compile.test.ts`, the authoritative gate.
 */
import type { SeedFile } from "@galley/collab";
import type { VersionedFile } from "@galley/shared";

// ── Live tree (the polished post-September state) ──────────────────────────
import liveStyle from "./live/style.typ?raw";
import mainLive from "./live/main.typ?raw";
import photoelectricLive from "./live/photoelectric.typ?raw";
import brownianLive from "./live/brownian.typ?raw";
import relativityLive from "./live/relativity.typ?raw";
import spacetimeLive from "./live/spacetime.typ?raw";
import marginaliaLive from "./live/marginalia.typ?raw";

// ── History drafts (each a coherent earlier full tree, spec §4) ────────────
import mainMarch from "./drafts/main-march.typ?raw";
import photoelectricMarch from "./drafts/photoelectric-march.typ?raw";
import mainMay from "./drafts/main-may.typ?raw";
import brownianMay from "./drafts/brownian-may.typ?raw";
import mainJune from "./drafts/main-june.typ?raw";
import relativityJune from "./drafts/relativity-june.typ?raw";
import massEnergySeptember from "./drafts/mass-energy-september.typ?raw";

/**
 * The bibliography — real period references, every key actually cited via
 * `@key` in the papers (and the cite-autocomplete source once seeded).
 * Inline (not `?raw`): see the module docs.
 */
const REFS_BIB = `@article{lorentz1904,
  author  = {Lorentz, Hendrik Antoon},
  title   = {Electromagnetic phenomena in a system moving with any velocity smaller than that of light},
  journal = {Proceedings of the Royal Netherlands Academy of Arts and Sciences},
  volume  = {6},
  pages   = {809--831},
  year    = {1904},
}

@article{planck1901,
  author  = {Planck, Max},
  title   = {Über das Gesetz der Energieverteilung im Normalspectrum},
  journal = {Annalen der Physik},
  volume  = {309},
  number  = {3},
  pages   = {553--563},
  year    = {1901},
}

@article{maxwell1865,
  author  = {Maxwell, James Clerk},
  title   = {A dynamical theory of the electromagnetic field},
  journal = {Philosophical Transactions of the Royal Society of London},
  volume  = {155},
  pages   = {459--512},
  year    = {1865},
}

@article{michelson1887,
  author  = {Michelson, Albert A. and Morley, Edward W.},
  title   = {On the relative motion of the Earth and the luminiferous ether},
  journal = {American Journal of Science},
  volume  = {34},
  number  = {203},
  pages   = {333--345},
  year    = {1887},
}

@article{lenard1902,
  author  = {Lenard, Philipp},
  title   = {Über die lichtelektrische Wirkung},
  journal = {Annalen der Physik},
  volume  = {313},
  number  = {5},
  pages   = {149--198},
  year    = {1902},
}

@book{boltzmann1896,
  author    = {Boltzmann, Ludwig},
  title     = {Vorlesungen über Gastheorie},
  publisher = {J. A. Barth},
  location  = {Leipzig},
  year      = {1896},
}
`;

/** The entry file of the demo workspace. */
export const DEMO_MAIN = "/main.typ";

/**
 * The live seed tree — the polished post-September state of the desk.
 * Same `{ path, text }` shape as `SAMPLE_PROJECT_FILES` (`project-sample.ts`),
 * ready for `seedIfPristine(DEMO_FILES, DEMO_MAIN, author)` in #20.2.
 */
export const DEMO_FILES: SeedFile[] = [
  { path: "/main.typ", text: mainLive },
  { path: "/style.typ", text: liveStyle },
  { path: "/photoelectric.typ", text: photoelectricLive },
  { path: "/brownian.typ", text: brownianLive },
  { path: "/relativity.typ", text: relativityLive },
  { path: "/spacetime.typ", text: spacetimeLive },
  { path: "/marginalia.typ", text: marginaliaLive },
  { path: "/refs.bib", text: REFS_BIB },
];

/**
 * One named history version: the arguments `seedDemoHistory` (#20.2) will pass
 * to `VersionStore.createVersion(projectId, { name }, tree)` — see
 * `@galley/shared`'s `VersionStore` and `idb-version-store.ts`.
 */
export interface DemoHistoryVersion {
  name: string;
  tree: VersionedFile[];
}

/**
 * /relativity.typ as of 27 September 1905: the June text with the mass–energy
 * addendum appended verbatim, so Version Compare of June ↔ September shows
 * exactly the E = mc² section appearing (spelled-out constants, no diff
 * machinery).
 */
const RELATIVITY_SEPTEMBER = `${relativityJune}\n${massEnergySeptember}`;

/**
 * The four pre-seeded 1905 versions, oldest first — each a coherent FULL tree
 * (the version store stores materialized trees, not deltas). The live
 * workspace (`DEMO_FILES`) is the polished state that follows them.
 */
export const DEMO_HISTORY: DemoHistoryVersion[] = [
  {
    name: "17 March 1905 — On a heuristic viewpoint: light quanta",
    tree: [
      { path: "/main.typ", text: mainMarch },
      { path: "/photoelectric.typ", text: photoelectricMarch },
      { path: "/refs.bib", text: REFS_BIB },
    ],
  },
  {
    name: "11 May 1905 — Brownian motion submitted",
    tree: [
      { path: "/main.typ", text: mainMay },
      { path: "/photoelectric.typ", text: photoelectricLive },
      { path: "/brownian.typ", text: brownianMay },
      { path: "/refs.bib", text: REFS_BIB },
    ],
  },
  {
    name: "30 June 1905 — On the electrodynamics of moving bodies",
    tree: [
      { path: "/main.typ", text: mainJune },
      { path: "/photoelectric.typ", text: photoelectricLive },
      { path: "/brownian.typ", text: brownianLive },
      { path: "/relativity.typ", text: relativityJune },
      { path: "/spacetime.typ", text: spacetimeLive },
      { path: "/refs.bib", text: REFS_BIB },
    ],
  },
  {
    name: "27 September 1905 — Does the inertia of a body depend upon its energy-content?",
    tree: [
      { path: "/main.typ", text: mainJune },
      { path: "/photoelectric.typ", text: photoelectricLive },
      { path: "/brownian.typ", text: brownianLive },
      { path: "/relativity.typ", text: RELATIVITY_SEPTEMBER },
      { path: "/spacetime.typ", text: spacetimeLive },
      { path: "/refs.bib", text: REFS_BIB },
    ],
  },
];
