// "Folin phenol" journal style — the bespoke style of the Lowry 1951 demo,
// implementing the canonical Galley style ABI so the Style Library can swap it
// in place. It dresses the manuscript as a mid-century biochemistry journal
// article would appear today: a small-caps masthead, a full-width title block
// and structured abstract, then a justified TWO-COLUMN body — the house format
// of the Journal of Biological Chemistry, where Lowry et al. published.
//
// Canonical entry: doc(title, author, date, abstract, body, ..extra). The
// masthead carries journal-specific chrome that is NOT in the canonical ABI —
// `journal`, `articletype`, `affiliation`, `received` — declared as extra named
// params BEFORE `body, ..extra`. A generic built-in style receives those in its
// `..extra` sink and ignores them, so the body still restyles cleanly. Pure
// built-in Typst: serif body in New Computer Modern, sans masthead/headings in
// Inter (both bundled), so it compiles offline in the fail-closed worker.

#let accent = rgb("#8c2b22")
#let ink = rgb("#1b1b1b")
#let ink-soft = rgb("#6c6c6c")
#let rule = rgb("#cdcdcd")

#let doc(
  title: none,
  author: none,
  date: none,
  abstract: none,
  journal: none,
  articletype: none,
  affiliation: none,
  received: none,
  body,
  ..extra,
) = {
  set page(
    paper: "us-letter",
    margin: (x: 1.9cm, top: 2.0cm, bottom: 2.0cm),
    fill: white,
    numbering: "1",
    number-align: center,
    // A running head from page 2 on — the journal name left, the byline right —
    // kept off the title page so the masthead stands alone.
    header: context {
      if counter(page).get().first() > 1 {
        set text(font: "Inter", size: 7.5pt, fill: ink-soft, style: "italic")
        grid(
          columns: (1fr, 1fr),
          align: (left + horizon, right + horizon),
          [#journal],
          align(right)[Lowry, Rosebrough, Farr & Randall],
        )
        v(0.2em)
        line(length: 100%, stroke: 0.4pt + rule)
      }
    },
  )
  set text(font: "New Computer Modern", size: 9.5pt, fill: ink)
  set par(justify: true, leading: 0.62em, first-line-indent: 1.1em, spacing: 0.62em)
  set math.equation(numbering: "(1)")
  set heading(numbering: none)

  // Section headings: a compact uppercase sans rubric in the accent; subsections
  // an italic serif run-in. Both sit comfortably inside a narrow column.
  show heading.where(level: 1): it => block(above: 1.15em, below: 0.5em)[
    #set text(font: "Inter", size: 8pt, weight: 700, fill: accent, tracking: 0.09em)
    #upper(it.body)
  ]
  show heading.where(level: 2): it => block(above: 0.8em, below: 0.35em)[
    #set text(font: "New Computer Modern", size: 9.5pt, weight: 700, style: "italic", fill: ink)
    #it.body
  ]

  // ── Masthead ──────────────────────────────────────────────────────────────
  block(width: 100%)[
    #grid(
      columns: (1fr, auto),
      align: (left + horizon, right + horizon),
      text(font: "Inter", size: 12.5pt, weight: 800, fill: accent, tracking: 0.03em)[
        #smallcaps(if journal != none { journal } else { [Journal] })
      ],
      text(font: "Inter", size: 7pt, weight: 600, fill: ink-soft, tracking: 0.2em)[
        #upper(if articletype != none { articletype } else { [Article] })
      ],
    )
  ]
  v(0.3em)
  line(length: 100%, stroke: 1.3pt + accent)
  v(0.12em)
  line(length: 100%, stroke: 0.5pt + rule)
  v(1.0em)

  // ── Title block (full width) ────────────────────────────────────────────
  if title != none {
    text(size: 17pt, weight: 700)[#title]
  }
  if author != none {
    v(0.45em)
    text(size: 10.5pt)[#author]
  }
  if affiliation != none {
    v(0.18em)
    text(size: 8.5pt, fill: ink-soft, style: "italic")[#affiliation]
  }
  if received != none {
    v(0.3em)
    text(font: "Inter", size: 7pt, fill: ink-soft, tracking: 0.04em)[#upper(received)]
  }

  // ── Abstract (full width, set off by hairlines) ─────────────────────────
  if abstract != none {
    v(0.85em)
    block(
      width: 100%,
      stroke: (top: 0.5pt + rule, bottom: 0.5pt + rule),
      inset: (y: 0.75em),
    )[
      #set text(size: 9pt)
      #set par(justify: true, first-line-indent: 0em, leading: 0.58em)
      #text(font: "Inter", size: 7pt, weight: 700, fill: accent, tracking: 0.12em)[ABSTRACT]
      #h(0.6em)
      #abstract
    ]
  }

  // ── Two-column body (the journal house format) ───────────────────────────
  v(1.0em)
  columns(2, gutter: 1.4em, body)
}
