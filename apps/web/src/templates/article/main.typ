// Article — a two-file scholarly template.
//
// Pure built-in Typst: no Universe packages, so it compiles offline in the
// fail-closed worker and under the math-font-less Node/e2e gate. The shared
// look lives in `/style.typ`; this file `#import`s it, proving virtual
// cross-file resolution. Math is real Typst math mode ($...$) — NewCMMath is
// bundled, so the relations typeset with proper glyphs.

#import "/style.typ": article, accent, ink-soft, line-strong

#show: article.with(
  title: "On the Convergence of Iterative Methods",
  author: "A. N. Author",
  affiliation: "Department of Numerical Analysis",
  date: "June 2026",
  abstract: [
    We revisit fixed-point iteration for the equation $x = g(x)$ and give a
    self-contained proof that a contraction on a complete interval converges to
    a unique root. A worked example and an error table illustrate the geometric
    rate predicted by the theory.
  ],
)

= Introduction

Many problems reduce to finding a value $x^*$ left unchanged by a map $g$, that
is, a *fixed point* satisfying

$ x^* = g(x^*). $

The simplest scheme guesses $x_0$ and repeats $x_(n+1) = g(x_n)$. Whether the
sequence settles on $x^*$ or wanders off depends entirely on how strongly $g$
stretches distances near the root.

= The contraction condition

Call $g$ a _contraction_ on an interval $I$ if there is a constant
$0 <= L < 1$ with

$ |g(x) - g(y)| <= L |x - y| quad "for all" x, y in I. $

#block(
  inset: (left: 0.95em),
  stroke: (left: 1.5pt + accent),
  above: 0.8em,
  below: 0.8em,
)[
  #set par(first-line-indent: 0em)
  *Theorem (Banach, restricted).*~~If $g$ maps a closed interval $I$ into
  itself and is a contraction there with constant $L$, then $g$ has exactly one
  fixed point $x^*$ in $I$, and every iterate obeys
  $ |x_n - x^*| <= L^n |x_0 - x^*|. $
]

The bound is the whole story: errors shrink by at least a factor $L$ each step,
so the iteration converges _linearly_ with rate $L$. Halving the error takes
about $log 2 \/ log(1 \/ L)$ steps regardless of where we start in $I$.

= A worked example

Solving $x = cos x$ on $I = [0, 1]$ sets $g(x) = cos x$. Since
$g'(x) = -sin x$ and $|sin x| <= sin 1 approx 0.841 < 1$ on $I$, the map is a
contraction and the iteration must converge to the Dottie number
$x^* approx 0.739085$.

#v(0.4em)
#align(center)[
  #table(
    columns: 3,
    align: (center, right, right),
    stroke: none,
    inset: (x: 1.1em, y: 0.45em),
    fill: (_, row) => if row == 0 { rgb("#efe9dd") } else if calc.odd(row) { rgb("#fffdf8") } else { none },
    table.header(
      text(weight: "bold")[$n$],
      text(weight: "bold")[$x_n$],
      text(weight: "bold")[$|x_n - x^*|$],
    ),
    [0], [1.000000], [0.260915],
    [1], [0.540302], [0.198783],
    [2], [0.857553], [0.118468],
    [3], [0.654290], [0.084795],
    [4], [0.793480], [0.054395],
    [5], [0.701369], [0.037716],
  )
]

#v(0.3em)
#align(center, text(size: 8.5pt, fill: ink-soft, style: "italic")[
  Table 1. Successive iterates of $x_(n+1) = cos x_n$ and their distance to the
  root. The error contracts by roughly $0.67$ each step, matching $L = sin 1$.
])

= Conclusion

A single inequality — the contraction bound — controls both _whether_ fixed-point
iteration converges and _how fast_. The same argument underlies Newton's method
and the proof of existence for ordinary differential equations.

#v(0.6em)
#line(length: 100%, stroke: 0.4pt + line-strong)
#v(0.3em)
#text(size: 8.5pt, fill: ink-soft)[
  Edit `/style.typ` to restyle the whole article — title block, headings, and
  page geometry all live there.
]
