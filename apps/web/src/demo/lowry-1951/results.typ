// Results — the standard curve, its (mild) non-linearity, sensitivity, and the
// chief interferences. A small narrow table fits within a column. Content only.

= The Standard Curve

Over the working range the colour obeys the Beer--Lambert law closely enough for
routine work: the absorbance $A$ of a layer of thickness $b$ is

$ A = epsilon b c $

with $c$ the protein concentration and $epsilon$ an apparent extinction that is
constant for a given protein and reagent batch. A representative run with bovine
serum albumin, read at $750 #h(0.1em) "m" mu$ in a $1 #h(0.1em) "cm"$ cell, gave

#align(center)[
  #block(breakable: false)[
    #set text(size: 8pt)
    #table(
      columns: (auto, auto),
      align: (center + horizon, center + horizon),
      stroke: none,
      inset: (x: 0.8em, y: 0.34em),
      fill: (_, row) => if row == 0 { rgb("#eee7e6") } else { none },
      table.header([Protein ($mu$g)], [$A_750$]),
      [10], [0.10],
      [25], [0.24],
      [50], [0.45],
      [100], [0.82],
    )
  ]
]

The plot is very nearly a straight line through the origin but bends gently
downward at the upper end: equal increments of protein add slightly less colour
as the concentration rises, so a curve — not a single factor — should be carried
through the whole range. The departure is small below $50 #h(0.1em) mu"g"$ and is
of no consequence for most determinations.

= Sensitivity and Interferences

The method responds to a few micrograms of protein, roughly a hundred times the
sensitivity of the biuret reaction and several times that of ultraviolet
absorption. The colour is stable for an hour or more once developed.

Few of the substances met with in biological work interfere seriously. Sucrose,
glycerol, and the common neutral salts are tolerated. Strong acid lowers the
colour by neutralising the alkali before the phenol reagent can act, and should
be balanced beforehand; ammonium sulphate above a few per cent depresses it
similarly. Tris and other amine buffers, phenols, and reducing agents such as
thiol compounds give colour of their own and must be allowed for in the blank.
Within these limits the procedure is rapid, sensitive, and reproducible, and well
suited to the small samples of the enzyme laboratory.
