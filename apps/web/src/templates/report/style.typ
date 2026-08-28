// Shared style for the Report template. Pure built-in Typst. `main.typ` applies
// `#show: report-page` to set page geometry, type, and heading rules once for
// the whole document; the chapter files only contribute content.

#let accent = rgb("#1f3a5f")
#let ink = rgb("#1b1b1b")
#let ink-soft = rgb("#5b5b5b")
#let line-strong = rgb("#d8d8d4")

#let report-page(body) = {
  set page(
    paper: "a4",
    margin: (x: 2.5cm, y: 2.6cm),
    numbering: "1",
    fill: white,
  )
  set text(font: "New Computer Modern", size: 10.5pt, fill: ink)
  set par(justify: true, leading: 0.7em, first-line-indent: 1.2em)
  set heading(numbering: "1.")
  show heading.where(level: 1): set text(size: 15pt, weight: 700)
  show heading.where(level: 2): set text(size: 12pt, weight: 600)
  show heading: it => { it; v(0.2em) }
  set math.equation(numbering: "(1)")
  body
}

// A small caption helper reused across chapters.
#let caption(body) = align(center, text(size: 8.5pt, fill: ink-soft, style: "italic")[#body])
