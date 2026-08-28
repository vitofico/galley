// Chapter 1 — exported as a content block and `#import`ed by /main.typ.
#let introduction = [
  = Introduction

  The Galley pipeline compiles Typst sources to rendered pages entirely in the
  browser. As documents grow and collaborators join a shared room, compile
  latency becomes the dominant factor in perceived responsiveness. This report
  measures that latency under increasing load and identifies where time is
  spent.

  We focus on three questions:

  + How does compile time scale with document size?
  + What fraction of a round trip is the WASM compile versus rendering?
  + Does concurrent editing in a shared room degrade either?

  The remaining chapters describe the measurement *Methods* and present the
  *Results*, including a summary table of the headline figures.
]
