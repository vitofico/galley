// "Annus Mirabilis" — Einstein's desk, Bern, 1905 (roadmap #20). The cover
// sheet of the demo workspace: the abstract of the year, the table of contents,
// and the #include chain binding the four papers, the workbench notes, and the
// bibliography into one document. The look (a5 cover, leaf breaks, numbering,
// palette) lives in /style.typ — a conforming Galley style — so the Style
// Library can swap it in place. Pure built-in Typst — no @preview packages — so
// it compiles offline in the fail-closed worker with the bundled New Computer
// Modern fonts (math included).

#import "/style.typ": doc

#show: doc.with(
  title: "Annus Mirabilis",
  author: "A. Einstein --- technical expert, third class",
  eyebrow: "BERN · KRAMGASSE 49 · 1905",
  subtitle: "Four papers from a desk at the patent office",
  abstract: [
    *Abstract of the year.* Within a single twelvemonth the following questions
    are taken up: whether light is grain or wave (March); whether the atoms of
    the kinetic theory can be _seen_ at work in a droplet of water (May); what
    becomes of space and time when no signal outruns light (June); and whether
    the inertia of a body is nothing but a ledger of its energy (September).
    The papers are gathered here as they stand on the desk, with a private
    geometric sketch and the workbench notes appended.
  ],
)

#outline(title: [Contents of the Year], indent: auto, depth: 2)

// ── The papers ────────────────────────────────────────────────────────────
#include "/photoelectric.typ"
#include "/brownian.typ"
#include "/relativity.typ"
#include "/spacetime.typ"

// ── Workbench notes & references ──────────────────────────────────────────
#include "/marginalia.typ"

#bibliography("refs.bib", title: [References])
