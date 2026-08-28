// "Annus Mirabilis academic" — the bespoke style of the Einstein desk demo,
// implementing the canonical Galley style ABI so the Style Library can swap it
// in place. It absorbs the styling that main.typ used to inline (a5 page on
// #fffdf8, New Computer Modern 10pt ink, justified paragraphs, numbered
// headings with a per-paper leaf break, equation numbering) AND draws the cover
// sheet (eyebrow · title · subtitle · accent rule · abstract · author footer).
//
// Canonical entry: doc(title, author, date, abstract, body, ..extra). The
// cover carries demo-specific chrome that is NOT in the canonical ABI —
// `eyebrow` and `subtitle` — declared as extra named params BEFORE `body,
// ..extra`. A generic built-in style receives those in its `..extra` sink and
// ignores them, so the body still restyles cleanly. Pure built-in Typst: it
// compiles offline against the bundled New Computer Modern fonts.

#let accent = rgb("#f0510e")
#let ink = rgb("#211c17")
#let ink-soft = rgb("#6a6155")
#let rule = rgb("#d8cdb8")

#let doc(
  title: none,
  author: none,
  date: none,
  abstract: none,
  eyebrow: none,
  subtitle: none,
  body,
  ..extra,
) = {
  set page(paper: "a5", margin: (x: 1.85cm, y: 1.9cm), fill: rgb("#fffdf8"), numbering: "1")
  set text(font: "New Computer Modern", size: 10pt, fill: ink)
  set par(justify: true, leading: 0.72em, first-line-indent: 1.2em)
  set heading(numbering: "I.1.")
  set math.equation(numbering: "(1)")

  // Every paper opens on its own leaf.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    set text(size: 13.5pt, weight: 700)
    block(above: 1.4em, below: 0.9em, it)
  }
  show heading.where(level: 2): set text(size: 11pt, weight: 600)

  // ── Cover ───────────────────────────────────────────────────────────────
  v(1.6cm)
  align(center)[
    #if eyebrow != none {
      text(size: 8pt, weight: 600, fill: accent, tracking: 0.32em)[#upper(eyebrow)]
      v(1.1em)
    }
    #if title != none {
      text(size: 30pt, weight: 700, tracking: 0.01em)[#title]
    }
    #if subtitle != none {
      v(0.55em)
      text(size: 11.5pt, fill: ink-soft, style: "italic")[#subtitle]
    }
    #v(1.0em)
    // A short hairline split by a small accent lozenge — a more composed divider
    // than a single rule, still restrained for an academic title page. The lozenge
    // is drawn (a rotated square), so it needs no special font glyph coverage.
    #box(width: 34%)[
      #grid(
        columns: (1fr, auto, 1fr),
        align: horizon,
        line(length: 100%, stroke: 0.5pt + rule),
        box(inset: (x: 0.6em))[#rotate(45deg, rect(width: 4pt, height: 4pt, fill: accent))],
        line(length: 100%, stroke: 0.5pt + rule),
      )
    ]
  ]

  if abstract != none {
    v(1.1cm)
    block(inset: (x: 0.55cm))[
      #set text(size: 9.5pt)
      #set par(first-line-indent: 0em)
      #abstract
    ]
  }

  if author != none {
    v(1fr)
    align(center)[
      #text(size: 9pt, fill: ink-soft)[#author]
    ]
    v(0.4cm)
  }

  pagebreak()

  body
}
