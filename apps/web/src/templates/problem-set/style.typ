// Shared style for the Problem Set template. Pure built-in Typst — no packages,
// so the project compiles offline in the fail-closed worker and under the
// math-font-less gate. `main.typ` applies `#show: pset.with(...)` for the header
// and page rules, and uses the `problem` / `solution` helpers for each item.

#let accent = rgb("#5a3e8c")
#let ink = rgb("#1b1b1b")
#let ink-soft = rgb("#5b5b5b")
#let line-soft = rgb("#d8d8d4")
#let solution-bg = rgb("#f3eefb")

// Document template: a header block (course / title / author) and one-column
// body with numbered "Problem N." headings via a counter.
#let pset(
  course: "Course",
  title: "Problem Set",
  author: none,
  due: none,
  body,
) = {
  set page(
    paper: "a4",
    margin: (x: 2.4cm, y: 2.4cm),
    numbering: "1",
  )
  set text(font: "New Computer Modern", size: 10.5pt, fill: ink)
  set par(justify: true, leading: 0.7em)
  set enum(numbering: "(a)")
  set math.equation(numbering: "(1)")

  // Header.
  grid(
    columns: (1fr, auto),
    align: (left + bottom, right + bottom),
    [
      #text(size: 9pt, fill: accent, tracking: 0.12em)[#upper(course)]
      #v(0.15em)
      #text(size: 16pt, weight: 700)[#title]
    ],
    if author != none or due != none {
      text(size: 9pt, fill: ink-soft)[
        #if author != none [#author \ ]
        #if due != none [Due: #due]
      ]
    },
  )
  v(0.3em)
  line(length: 100%, stroke: 1pt + accent)
  v(0.6em)

  body
}

// A numbered problem. The counter advances on each call, so problems stay
// numbered even if reordered.
#let problem-counter = counter("problem")
#let problem(points: none, body) = {
  problem-counter.step()
  block(spacing: 0.8em)[
    #text(weight: 700)[Problem #context problem-counter.display(). #(
      if points != none {
        text(weight: 400, fill: ink-soft)[(#points pts)]
      }
    )]
    #v(0.2em)
    #body
  ]
}

// A tinted, set-apart solution block.
#let solution(body) = block(
  width: 100%,
  fill: solution-bg,
  inset: 0.8em,
  radius: 4pt,
  above: 0.5em,
  below: 0.9em,
)[
  #text(size: 8.5pt, weight: 700, fill: accent, tracking: 0.1em)[SOLUTION]
  #v(0.2em)
  #body
]
