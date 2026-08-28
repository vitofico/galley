// Modern — an airy, accent-driven style: large unnumbered headings, generous
// whitespace, a tinted abstract card. Set in Inter (a bundled open-licensed sans,
// SIL OFL 1.1), so it reads as a true contemporary sans face — not just the serif
// under a different layout. Canonical ABI.
#let accent = rgb("#2563eb")
#let ink = rgb("#1f2933")
#let ink-soft = rgb("#7b8794")
#let rule = rgb("#e4e7eb")

#let doc(title: none, author: none, date: none, abstract: none, body, ..extra) = {
  set page(paper: "a4", margin: (x: 2.6cm, y: 2.8cm), fill: white)
  set text(font: "Inter", size: 11pt, fill: ink)
  set par(leading: 0.8em)
  set heading(numbering: none)
  show heading: set text(fill: accent, weight: 700)

  if title != none {
    text(size: 22pt, weight: 800, fill: ink)[#title]
    v(0.2em)
  }
  if author != none {
    text(size: 11pt, fill: ink-soft)[#author]
  }
  if date != none {
    text(size: 10pt, fill: ink-soft)[ · #date]
  }
  if abstract != none {
    v(0.6em)
    block(fill: rule, inset: 1em, radius: 6pt, width: 100%)[#abstract]
  }

  v(0.8em)
  body
}
