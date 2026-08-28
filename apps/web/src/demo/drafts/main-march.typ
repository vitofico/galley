// History draft — /main.typ as it stood on 17 March 1905, the day the
// light-quanta paper went to the Annalen. One paper in the folder; the rest
// of the year still ahead. Seeded as version 1 of the demo history.

#set page(
  paper: "a5",
  margin: (x: 1.85cm, y: 1.9cm),
  fill: rgb("#fffdf8"),
  numbering: "1",
)
#set text(font: "New Computer Modern", size: 10pt, fill: rgb("#211c17"))
#set par(justify: true, leading: 0.72em, first-line-indent: 1.2em)
#set heading(numbering: "I.1.")
#set math.equation(numbering: "(1)")

#let accent = rgb("#f0510e")
#let ink-soft = rgb("#6a6155")

#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  set text(size: 13.5pt, weight: 700)
  block(above: 1.4em, below: 0.9em, it)
}
#show heading.where(level: 2): set text(size: 11pt, weight: 600)

#v(1.3cm)
#align(center)[
  #text(size: 8.5pt, fill: accent, tracking: 0.22em)[BERN · 1905 · WORKING PAPERS]
  #v(0.9em)
  #text(size: 22pt, weight: 700)[Papers of the Year]
  #v(0.4em)
  #text(size: 11pt, fill: ink-soft, style: "italic")[
    First: on the nature of light
  ]
  #v(0.8em)
  #line(length: 30%, stroke: 0.8pt + accent)
]

#v(1.1cm)

#block(inset: (x: 0.55cm))[
  #set text(size: 9.5pt)
  #set par(first-line-indent: 0em)
  One paper is away to the Annalen --- the light-quantum heresy. The Brownian
  calculation looks promising; the electrodynamics still refuses to close.
  More to follow.
]

#v(1fr)
#align(center)[
  #text(size: 9pt, fill: ink-soft)[A. Einstein --- technical expert, third class]
]
#v(0.4cm)

#pagebreak()

#outline(title: [Contents], indent: auto, depth: 2)

#include "/photoelectric.typ"

#bibliography("refs.bib", title: [References])
