// Technical report — a multi-file template. `main.typ` owns the cover and the
// global styling, then pulls each chapter in from `/chapters/` with a virtual
// `#import`. Pure built-in Typst (no Universe packages), so the whole project compiles
// offline in the fail-closed worker and under the math-font-less gate.

#import "/style.typ": report-page, accent, ink-soft, line-strong
#import "/chapters/introduction.typ": introduction
#import "/chapters/methods.typ": methods
#import "/chapters/results.typ": results

#show: report-page

// ── Cover ─────────────────────────────────────────────────────────────────────
#align(center + horizon)[
  #text(size: 9pt, fill: accent, tracking: 0.22em)[TECHNICAL REPORT · 2026]
  #v(0.4em)
  #text(size: 26pt, weight: 700)[Throughput of the Galley Pipeline]
  #v(0.3em)
  #text(size: 12pt, fill: ink-soft, style: "italic")[
    A measurement study of compile latency under load
  ]
  #v(0.8em)
  #line(length: 26%, stroke: 0.8pt + accent)
  #v(0.8em)
  #text(size: 10.5pt)[Performance Working Group]
]

#pagebreak()

// ── Contents ──────────────────────────────────────────────────────────────────
#outline(title: [Contents], indent: auto)
#pagebreak()

// ── Body: each chapter is its own file under /chapters/ ───────────────────────
#introduction
#methods
#results

#v(0.6em)
#line(length: 100%, stroke: 0.4pt + line-strong)
#v(0.3em)
#text(size: 8.5pt, fill: ink-soft)[
  Each chapter lives in its own file under `/chapters/`. Add a chapter by
  creating `/chapters/<name>.typ` that exports a content block, then `#import`
  and place it here.
]
