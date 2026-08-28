// Academic — a serif, justified, numbered-heading style. Canonical Galley ABI:
// exports `doc(...)` (all params optional except body, trailing `..extra` sink)
// plus the palette tokens accent / ink / ink-soft / rule. Pure built-in Typst —
// compiles offline against the bundled New Computer Modern font.
#let accent = rgb("#b23a25")
#let ink = rgb("#211c17")
#let ink-soft = rgb("#6a6155")
#let rule = rgb("#d8cdb8")

#let doc(title: none, author: none, date: none, abstract: none, body, ..extra) = {
  set page(paper: "a4", margin: (x: 2.4cm, y: 2.6cm), fill: rgb("#fffdf8"), numbering: "1")
  set text(font: "New Computer Modern", size: 10.5pt, fill: ink)
  set par(justify: true, leading: 0.72em, first-line-indent: 1.2em)
  set heading(numbering: "1.")
  show heading: set text(size: 12pt, weight: 600)
  set math.equation(numbering: "(1)")

  align(center)[
    #text(size: 18pt, weight: 700)[#title]
    #if author != none {
      v(0.5em)
      text(size: 11pt)[#author]
    }
    #if date != none {
      v(0.2em)
      text(size: 9.5pt, fill: ink-soft)[#date]
    }
    #v(0.35em)
    #line(length: 30%, stroke: 0.7pt + accent)
  ]

  if abstract != none {
    v(0.4em)
    block(width: 100%, inset: (x: 1.4em))[
      #set text(size: 9.5pt)
      #abstract
    ]
  }

  v(0.6em)
  body
}
