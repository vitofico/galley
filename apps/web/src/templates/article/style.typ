// Shared style for the Article template. Pure built-in Typst — every color and
// rule is a plain value, no packages. `main.typ` applies `article` with
// `#show: article.with(...)` and reuses the exported palette tokens.

#let accent = rgb("#b23a25")
#let ink = rgb("#211c17")
#let ink-soft = rgb("#6a6155")
#let line-strong = rgb("#d8cdb8")

// The document template: a centered title block followed by a one-column body
// with numbered headings. Apply with `#show: article.with(title: …, …)`.
#let article(
  title: "Untitled",
  author: none,
  affiliation: none,
  date: none,
  abstract: none,
  body,
) = {
  set page(
    paper: "a4",
    margin: (x: 2.4cm, y: 2.6cm),
    fill: rgb("#fffdf8"),
    numbering: "1",
  )
  set text(font: "New Computer Modern", size: 10.5pt, fill: ink)
  set par(justify: true, leading: 0.72em, first-line-indent: 1.2em)
  set heading(numbering: "1.")
  show heading: set text(size: 12pt, weight: 600)
  set math.equation(numbering: "(1)")

  // Title block.
  align(center)[
    #text(size: 18pt, weight: 700)[#title]
    #if author != none {
      v(0.5em)
      text(size: 11pt)[#author]
    }
    #if affiliation != none {
      v(0.2em)
      text(size: 9.5pt, fill: ink-soft, style: "italic")[#affiliation]
    }
    #if date != none {
      v(0.2em)
      text(size: 9.5pt, fill: ink-soft)[#date]
    }
    #v(0.35em)
    #line(length: 30%, stroke: 0.7pt + accent)
  ]

  v(0.4em)

  // Abstract, indented and set apart.
  if abstract != none {
    block(
      width: 100%,
      inset: (x: 1.4em),
      above: 0.6em,
      below: 1em,
    )[
      #set par(first-line-indent: 0em, leading: 0.66em)
      #text(size: 8.5pt, fill: ink-soft, weight: 600, tracking: 0.12em)[ABSTRACT]
      #v(0.3em)
      #text(size: 9.5pt)[#abstract]
    ]
  }

  body
}
