// Chapter 2 — pulls the shared `caption` helper from /style.typ.
#import "/style.typ": caption

#let methods = [
  = Methods

  Each trial compiled a synthetic document of $N$ sections through the same
  WASM compiler the application ships, recording wall-clock time for the
  `check` and `render` phases separately. We model the total time per compile as

  $ T(N) = T_0 + alpha N, $

  a fixed startup cost $T_0$ plus a per-section cost $alpha$. Fitting the line
  to the measured points recovers both constants and lets us extrapolate.

  == Apparatus

  Trials ran headless against the production WASM build with the default font
  set staged locally. Each configuration was repeated thirty times; we report
  the median to suppress the occasional garbage-collection spike.

  #v(0.3em)
  #caption[
    All timings are medians of thirty runs on a warm worker; the first
    (cold-start) compile of each session is excluded.
  ]
]
