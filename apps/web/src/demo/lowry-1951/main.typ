// "Protein Measurement with the Folin Phenol Reagent" — a faithful reconstruction
// of the most-cited paper in the scientific literature (Lowry, Rosebrough, Farr &
// Randall, J. Biol. Chem. 193 (1951) 265), staged as the Galley journal-style demo
// workspace. The look — masthead, full-width title and abstract, justified
// two-column body — lives in /style.typ, a conforming Galley style, so the Style
// Library can swap it in place (academic / modern / minimal). Pure built-in Typst,
// no @preview packages, so it compiles offline in the fail-closed worker with the
// bundled New Computer Modern (math included) and Inter fonts.

#import "/style.typ": doc

#show: doc.with(
  title: "Protein Measurement with the Folin Phenol Reagent",
  author: "Oliver H. Lowry, Nira J. Rosebrough, A. Lewis Farr, and Rose J. Randall",
  journal: "The Journal of Biological Chemistry",
  articletype: "Methods",
  affiliation: "Department of Pharmacology, Washington University School of Medicine, St. Louis, Missouri",
  received: "Received for publication, May 28, 1951",
  abstract: [
    A procedure is described for the colorimetric estimation of protein that
    couples the biuret reaction of peptide bonds with copper to the reduction of
    the Folin--Ciocalteu phenol reagent by tyrosine and tryptophan residues. The
    combined treatment is some hundredfold more sensitive than the biuret method
    and several times more sensitive than ultraviolet absorption at 280 m$mu$,
    responding to as little as a few micrograms of protein. The colour follows
    Beer's law over a useful working range, is stable, and is little disturbed by
    the substances commonly present in biological preparations. Reagents,
    procedure, the shape of the standard curve, and the principal interferences
    are set out below.
  ],
)

#include "/introduction.typ"
#include "/reagents.typ"
#include "/procedure.typ"
#include "/results.typ"

#bibliography("refs.bib", title: [References])
