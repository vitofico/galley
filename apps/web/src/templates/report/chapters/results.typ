// Chapter 3 — a results table plus the fitted constants.
#import "/style.typ": caption, accent

#let results = [
  = Results

  Compile time grew linearly with document size across the tested range, in good
  agreement with the model $T(N) = T_0 + alpha N$. The fit gives a startup cost
  of $T_0 approx 38 "ms"$ and a per-section cost of $alpha approx 4.2 "ms"$.

  #v(0.4em)
  #align(center)[
    #table(
      columns: 4,
      align: (right, right, right, right),
      stroke: none,
      inset: (x: 1.0em, y: 0.45em),
      fill: (_, row) => if row == 0 { rgb("#e7edf4") } else if calc.odd(row) { rgb("#fafbfd") } else { none },
      table.header(
        text(weight: "bold")[Sections $N$],
        text(weight: "bold")[Check (ms)],
        text(weight: "bold")[Render (ms)],
        text(weight: "bold")[Total (ms)],
      ),
      [10],  [21], [62],  [83],
      [25],  [48], [104], [152],
      [50],  [92], [171], [263],
      [100], [181], [298], [479],
      [200], [357], [551], [908],
    )
  ]
  #v(0.3em)
  #caption[
    Table 1. Median compile timings by document size. Render dominates at every
    size, but its share falls from $75%$ at $N = 10$ to $61%$ at $N = 200$.
  ]

  == Concurrency

  Adding up to four concurrent editors in a shared room left single-compile
  latency unchanged within noise: the compile worker is per-client, so
  collaboration cost is borne by the sync layer, not the compiler.

  #block(
    inset: (left: 0.95em),
    stroke: (left: 1.5pt + accent),
    above: 0.7em,
  )[
    #set par(first-line-indent: 0em)
    *Takeaway.*~~Rendering, not checking, is the lever. Caching unchanged pages
    across recompiles is the highest-value optimization the data points to.
  ]
]
