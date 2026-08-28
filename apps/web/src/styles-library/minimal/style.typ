// Minimal — restrained and rule-free: a tight neutral palette, a small title,
// justified serif body, no page numbers or heading numbers. Canonical ABI.
// `rule` is exported for ABI conformance even though this style draws no rules.
#let accent = rgb("#111111")
#let ink = rgb("#111111")
#let ink-soft = rgb("#666666")
#let rule = rgb("#dddddd")

#let doc(title: none, author: none, date: none, abstract: none, body, ..extra) = {
  set page(paper: "a4", margin: 3cm, fill: white)
  set text(font: "New Computer Modern", size: 11pt, fill: ink)
  set par(justify: true, leading: 0.7em)
  show heading: set text(weight: 600)

  if title != none {
    text(size: 16pt, weight: 700)[#title]
    v(0.3em)
  }
  if author != none {
    text(size: 10pt, fill: ink-soft)[#author]
    v(0.2em)
  }
  if date != none {
    text(size: 10pt, fill: ink-soft)[#date]
  }
  if abstract != none {
    v(0.5em)
    text(size: 10pt, style: "italic")[#abstract]
  }

  v(0.6em)
  body
}
