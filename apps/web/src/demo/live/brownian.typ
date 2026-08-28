// Paper II — "On the movement of small particles suspended in a stationary
// liquid" (11 May 1905): the random walk, ⟨x²⟩ = 2Dt, and a morning's
// displacement data. Included from /main.typ.

#let ink-soft = rgb("#6a6155")
#let line-soft = rgb("#d8cdb8")

= The Motion of Small Particles Suspended in a Liquid

#text(size: 8.5pt, fill: ink-soft, tracking: 0.12em)[
  ANNALEN DER PHYSIK · RECEIVED 11 MAY 1905
]
#v(0.5em)

If the kinetic theory of heat @boltzmann1896 is to be taken literally, then a
particle small enough to be jostled unequally from its two sides --- a grain of
pollen, a droplet of gamboge --- must wander visibly under the microscope,
driven by the molecular motions themselves. The wandering is a true random
walk: the displacements of successive intervals are independent, so it is not
the distance but the _square_ of the distance that grows with time. Along one
axis,

$ angle.l x^2 angle.r = 2 D t $

where the diffusion coefficient follows from the molecular theory as

$ D = (R T) / N_A dot 1 / (6 pi eta a) $

for grains of radius $a$ in a liquid of viscosity $eta$ at temperature $T$.
Every quantity on the right is measurable except $N_A$ --- so the formula,
read backwards, _counts the molecules_. Whoever measures the wandering of a
droplet weighs the invisible.

== A morning's measurements

#figure(
  caption: [
    Mean displacements of gamboge grains of radius about half a micron,
    in water at 17 °C, against the interval of observation.
  ],
  table(
    columns: (auto, 1fr, 1fr),
    align: (left + horizon, right + horizon, right + horizon),
    stroke: none,
    inset: (x: 0.9em, y: 0.45em),
    fill: (_, row) => if row == 0 { rgb("#efe9dd") } else if calc.odd(row) { rgb("#fffdf8") } else { none },
    table.header(
      [Interval $t$],
      [$sqrt(angle.l x^2 angle.r)$ observed (µm)],
      [predicted (µm)],
    ),
    [30 s], [0.59], [0.57],
    [60 s], [0.83], [0.80],
    [120 s], [1.09], [1.13],
    [240 s], [1.64], [1.60],
  ),
)

The agreement is as good as the patience of the observer. Should finer
measurements confirm the law, the reality of molecules passes from hypothesis
to bookkeeping.
